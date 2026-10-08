/**
 * The duel: owns the renderer, world, fighters, camera, HUD and audio, runs the fixed-step
 * simulation and resolves combat.
 *
 * Deflect rule (gameplay seconds, measured at the moment the general's swept blade first
 * touches the player's capsule):
 *   guard pressed in [contact - window, contact]                   → perfect deflect
 *   no press yet → held pending for DIFFICULTY.deflectLate; a press in time  → perfect deflect (late)
 *   guard held but pressed earlier than the window                 → regular block
 *   otherwise                                                      → hit
 * `window` is 0.2 s, shrunk by Input's anti-mash rule (never below 0.1 s).
 *
 * Perilous attacks (the red glyph): a thrust can't be blocked but can be deflected, sidestepped
 * (i-frames) or countered with the mikiri (a step dodge toward him); a sweep hits anything on
 * the roof in reach (jump it, kick off his head); a grab ignores guard (dodge or jump it).
 *
 * Lives: the player has one resurrection per fight (the gourd is not refilled by it). The
 * general has two deathblow markers: the first deathblow takes one and he rises for phase 2
 * at full vitality; the last is the finisher and VICTORY.
 *
 * Contact: the swept blade is tested in sub-steps, so the first touch is known to a few cm.
 * The attacker is re-posed to that instant and its animation is held (gameplay time keeps
 * running) until the outcome is known and the hitstop is over; a guarding defender brings its
 * blade through the touch point, sparks spawn exactly there, and a stopped swing rebounds
 * instead of following through the defender's body.
 */
import * as THREE from "three";
import { GameAudio } from "../audio/Audio";
import { cueOf, type Timeline } from "../chars/animEvents";
import type { Fighter, FighterRig } from "../chars/Fighter";
import { FighterSlot } from "../chars/FighterSlot";
import { General } from "../chars/General";
import { Shinobi } from "../chars/Shinobi";
import { FIXED_DT, Loop } from "../core/Loop";
import { Input } from "../core/Input";
import { clamp, damp, lerp, segSegDist, smooth } from "../core/math";
import { Fx } from "../fx/Fx";
import { Snow } from "../fx/Snow";
import { Post } from "../render/Post";
import { Hud } from "../ui/Hud";
import { Arena } from "../world/Arena";
import { RIM, SUN_DIR, installFog } from "../world/materials";
import { ATTACKS, BOSS_MAX, Boss, OPEN, type HitDef } from "./Boss";
import { applyDifficulty, DIFFICULTY, DIFFICULTY_NAMES, type DifficultyName, initialDifficulty, isDifficulty, rememberDifficulty } from "./difficulty";
import { CameraRig } from "./CameraRig";
import { KICK_REACH, PLAYER_MAX, Player, vitalityRegen } from "./Player";
import { wavedash } from "../wavedash";

export const HITSTOP_DEFLECT = 0.07;
export const HITSTOP_BLOCK = 0.04;
/** Consecutive deflects (each within DEFLECT_CHAIN_GAP of the last) deal more posture. */
export const DEFLECT_CHAIN_GAP = 1.0;
export const MIKIRI_POSTURE = 14;
export const KICK_HEAD_POSTURE = 14;
export const KICK_BODY_POSTURE = 4;
/** Deathblow reach. */
const DEATHBLOW_RANGE = 3.6;
/** Seconds after dying before the resurrection / defeat choice. */
const DEATH_BEAT = 1.3;

export function deflectPosture(h: HitDef, chain: number): number {
  return DIFFICULTY.deflectPosture * (1 + 0.12 * Math.min(chain, 4)) * (h.heavy ? 1.15 : 1);
}

type GState = "title" | "fight" | "deathblow" | "finisher" | "victory" | "dying" | "defeat";

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c1 = new THREE.Vector3();
const _c2 = new THREE.Vector3();
const _s0 = new THREE.Vector3();
const _s1 = new THREE.Vector3();
/** Sub-step spacing of the blade sweep (m of hilt / tip travel). */
const SWEEP_STEP = 0.06;
/** Blade-to-body clearance kept outside live strikes; released only once well clear. */
const AVOID_GAP = 0.03;
const AVOID_RELEASE = 0.2;

export interface DuelStats {
  deflects: number;
  lateDeflects: number;
  blocks: number;
  hitsTaken: number;
  dodged: number;
  /** Dodges whose i-frames carried her through a live blade (near-miss slow-mo). */
  nearMisses: number;
  playerHits: number;
  bossBlocks: number;
  /** The general turned the player's cut aside. */
  bossDeflects: number;
  breaks: number;
  deathblows: number;
  finishers: number;
  mikiri: number;
  sweepsJumped: number;
  headKicks: number;
  kicks: number;
  grabbed: number;
  grabsEvaded: number;
  heals: number;
  punishes: number;
  resurrections: number;
  victory: boolean;
  deaths: number;
  defeats: number;
  /** For each perfect deflect: seconds between the press and the blade contact (+ = early). */
  timings: number[];
  /** Predicted contact − actual contact, per boss hit that connected (bot calibration). */
  contactErr: number[];
  /** Player state / attack / seconds since the last guard press, for every hit taken. */
  hitLog: string[];
  maxPostureSeen: number;
}

export class Game {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(52, 16 / 9, 0.1, 3000);
  readonly post: Post;
  readonly arena: Arena;
  readonly snow = new Snow(9000);
  readonly fx: Fx;
  /** Procedural bodies (default + fallback); the slots may swap them for skinned ones. */
  readonly shinobi = new Shinobi();
  readonly general = new General();
  readonly playerBody = new FighterSlot(this.shinobi);
  readonly bossBody = new FighterSlot(this.general);
  readonly player: Player;
  readonly boss: Boss;
  readonly cam: CameraRig;
  readonly hud: Hud;
  readonly audio = new GameAudio();
  readonly input: Input;
  readonly loop: Loop;

  state: GState = "title";
  gameTime = 0;
  /** gameTime when the current fight began (victory time for the leaderboard). */
  private fightStartT = 0;
  private fightStartDeaths = 0;
  realTime = 0;
  private hitstop = 0;
  private slowT = 1;
  private slowDur = 1;
  private slowScale = 1;
  timeScale = 1;
  locked = true;
  private readonly wind = new THREE.Vector3();
  private windK = 0.4;
  private pending: { h: HitDef; t: number; predicted: number; at: THREE.Vector3 } | null = null;
  /** Blade contact of the current resolution: where the attacker's blade first touched. */
  readonly contact = new THREE.Vector3();
  private touchS = 1;
  private readonly touch = new THREE.Vector3();
  /** Bodies frozen at a contact until the hitstop (and any pending deflect) is over. */
  private readonly held = new Set<Fighter>();
  private finTl: Timeline | null = null;
  private avoidB = false;
  private avoidP = false;
  endT = 0;
  /** Fights begun (title / restart / tests): the death-loop repro counts these. */
  fightsStarted = 0;
  /** The title's choice; loaded into DIFFICULTY only when a fight starts (restarts keep it). */
  difficulty: DifficultyName = initialDifficulty();
  private promptShown = false;
  private desatTarget = 0;
  private barsTarget = 0;
  private finInk2 = false;
  private finPlunged = false;
  private deflectChain = 0;
  private lastDeflectT = -9;
  /** Boss attack serial whose sweep the player already cleared / whose throw already landed. */
  private sweepSeen = -1;
  private throwLanded = -1;
  private grabSeen = -1;

  readonly stats: DuelStats = this.freshStats();
  bot = {
    deflect: false,
    play: false,
    lead: 0.08,
    releaseAt: -1,
    pressed: [] as boolean[],
    attackId: -1,
    nextSwing: 0,
    healed: false,
    kickAt: -1,
    /** Tools: 0 = always mikiri a thrust; otherwise the share of thrusts the bot sidesteps instead. */
    sidestep: 0,
    /** Human-ish timing (fairness runs): ± seconds of error on every reaction, share of blows missed. */
    jitter: 0,
    miss: 0,
    seed: 1,
    plan: [] as { off: number; miss: boolean }[],
  };
  private botRand(): number {
    this.bot.seed = (this.bot.seed * 16807) % 2147483647;
    return this.bot.seed / 2147483647;
  }
  private frames = 0;
  private fpsT = 0;
  fps = 0;
  rendererName = "unknown";
  private paused = false;

  constructor(canvas: HTMLCanvasElement, hudRoot: HTMLElement) {
    installFog();
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance", stencil: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    const gl = this.renderer.getContext();
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    this.rendererName = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));

    this.arena = new Arena(this.scene);
    // Dusk reflections for steel and lacquer: bake the world (before the fighters exist).
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const envRT = pmrem.fromScene(this.scene, 0.02, 0.1, 2000);
    this.scene.environment = envRT.texture;
    this.scene.environmentIntensity = 0.32;
    pmrem.dispose();

    this.scene.add(this.snow.points);
    this.fx = new Fx(this.scene);
    this.playerBody.addTo(this.scene);
    this.bossBody.addTo(this.scene);
    this.player = new Player(this.playerBody);
    this.boss = new Boss(this.bossBody);
    this.cam = new CameraRig(this.camera);
    this.post = new Post(this.renderer, this.scene, this.camera, this.arena.surround.sunMesh);
    this.hud = new Hud(hudRoot);
    this.input = new Input(canvas);
    this.hud.setDifficulty(this.difficulty);
    this.hud.onDifficultyPick = (d) => {
      if (this.state === "title") this.setDifficulty(d, true);
    };
    this.input.onKeyDown = (code) => this.titleKey(code);
    this.loop = new Loop(
      (dt) => this.fixed(dt),
      (dt, alpha) => this.frame(dt, true, alpha),
    );
    window.addEventListener("resize", () => this.resize());
    this.resize();
    this.toTitle();
    // Warm up shaders and GPU buffers so the first deflect/finisher never hitches. The combat fx
    // start hidden and hidden objects are skipped, so show everything for one render.
    const hidden: THREE.Object3D[] = [];
    this.scene.traverse((o) => {
      if (!o.visible) {
        hidden.push(o);
        o.visible = true;
      }
    });
    // Render through the composer: the scene draws into its linear target, not the sRGB canvas,
    // and programs are keyed on that output colour space.
    this.post.render(1 / 60);
    for (const o of hidden) o.visible = false;
    this.hud.warm();
  }

  private freshStats(): DuelStats {
    return {
      deflects: 0,
      lateDeflects: 0,
      blocks: 0,
      hitsTaken: 0,
      dodged: 0,
      nearMisses: 0,
      playerHits: 0,
      bossBlocks: 0,
      bossDeflects: 0,
      breaks: 0,
      deathblows: 0,
      finishers: 0,
      mikiri: 0,
      sweepsJumped: 0,
      headKicks: 0,
      kicks: 0,
      grabbed: 0,
      grabsEvaded: 0,
      heals: 0,
      punishes: 0,
      resurrections: 0,
      victory: false,
      deaths: 0,
      defeats: 0,
      timings: [],
      contactErr: [],
      hitLog: [],
      maxPostureSeen: 0,
    };
  }

  start(): void {
    this.loop.start();
  }

  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.post.setSize(w, h);
  }

  // ------------------------------------------------------------------ flow

  /**
   * Every state change goes through here: it drops any armed prompt, so a menu answer can only
   * ever be read by the screen that asked for it.
   */
  private go(s: GState): void {
    // Pointer lock and the hidden cursor belong to the fight; every menu / overlay frees the mouse.
    const fighting = s === "fight" || s === "deathblow" || s === "finisher";
    this.input.lockable = fighting;
    document.body.classList.toggle("fighting", fighting);
    if (!fighting) this.input.releaseLock();
    else if (this.state !== "fight" && this.state !== "deathblow" && this.state !== "finisher") this.input.requestLock();
    this.state = s;
    this.endT = 0;
    this.promptShown = false;
    this.input.disarmPrompt();
  }

  private resetActors(): void {
    this.applyBodies();
    this.player.reset();
    this.boss.reset();
    this.fx.clear();
    this.fx.glyph.hide();
    this.fx.dot.active = false;
    this.pending = null;
    this.releaseHolds();
    this.hitstop = 0;
    this.slowT = this.slowDur = 1;
    this.timeScale = 1;
    this.desatTarget = 0;
    this.barsTarget = 0;
    this.post.fade = 0;
    this.finInk2 = false;
    this.finPlunged = false;
    this.deflectChain = 0;
    this.stats.victory = false;
    this.bot.healed = false;
    this.sweepSeen = this.throwLanded = this.grabSeen = -1;
    this.audio.setDuck(1);
    this.input.flush();
    this.input.resetMash();
    this.prevP.copy(this.player.pos);
    this.prevB.copy(this.boss.pos);
    // Settle poses and cloth.
    this.player.step(0, this.wind, this.gameTime);
    this.boss.step(0, this.wind, this.gameTime);
    this.playerBody.resetCloth();
    this.bossBody.resetCloth();
  }

  private releaseHolds(): void {
    for (const f of this.held) f.setHold(false);
    this.held.clear();
  }

  /**
   * Freeze `f` at the contact instant. The sweep interpolates blade endpoints (the chord of a
   * swing arc), so the fraction is refined by bisection on the actually re-posed blade until it
   * rests on the capsule surface.
   */
  private holdAtContact(f: Fighter, ca: THREE.Vector3, cb: THREE.Vector3, r: number): void {
    const rig = f.rig;
    const depth = (s: number) => {
      f.snapBack(s);
      return segSegDist(rig.hiltW, rig.tipW, ca, cb, _c1, _c2) - r;
    };
    let lo = 0;
    let hi = this.touchS;
    if (depth(lo) < 0) hi = 0;
    else if (depth(hi) >= 0) hi = 1;
    for (let i = 0; i < 7 && hi > lo; i++) {
      const mid = (lo + hi) / 2;
      if (depth(mid) < 0) hi = mid;
      else lo = mid;
    }
    // Closest point of the re-posed blade to the capsule: where the blades / body meet.
    depth(hi);
    this.contact.copy(_c1);
    f.setHold(true);
    this.held.add(f);
  }

  toTitle(): void {
    this.go("title");
    this.resetActors();
    this.stats.victory = false;
    this.boss.passive = true;
    this.cam.setMode("title");
    this.hud.showTitle(true);
    this.hud.showFight(false);
    this.hud.hideEnd();
    this.audio.setTaiko(false);
    this.input.armPrompt("any", 0.3);
  }

  /** Choose the difficulty for the next fight (the title's selector, tests). */
  setDifficulty(d: DifficultyName, remember = false): void {
    if (!isDifficulty(d)) return;
    this.difficulty = d;
    this.hud.setDifficulty(d);
    if (remember) rememberDifficulty(d);
  }

  /** Title selector keys: A / D or the arrows step, 1 / 2 / 3 pick (Input keeps them out of "any key"). */
  private titleKey(code: string): void {
    if (this.state !== "title") return;
    const i = DIFFICULTY_NAMES.indexOf(this.difficulty);
    const n = DIFFICULTY_NAMES.length;
    let j = -1;
    if (code === "KeyA" || code === "ArrowLeft") j = Math.max(0, i - 1);
    else if (code === "KeyD" || code === "ArrowRight") j = Math.min(n - 1, i + 1);
    else {
      const m = /^(?:Digit|Numpad)([1-9])$/.exec(code);
      if (m && +m[1] <= n) j = +m[1] - 1;
    }
    if (j >= 0 && j !== i) this.setDifficulty(DIFFICULTY_NAMES[j], true);
  }

  /** Title / defeat → the fight, opening with the general's leap straight off the keypress. */
  private beginIntro(): void {
    this.fightsStarted++;
    this.audio.start();
    this.audio.uiStart();
    applyDifficulty(this.difficulty);
    this.hud.fightDifficulty(this.difficulty);
    this.resetActors();
    this.fightStartT = this.gameTime;
    this.fightStartDeaths = this.stats.deaths;
    this.go("fight");
    this.hud.showTitle(false);
    this.hud.hideEnd();
    this.hud.showFight(true);
    this.cam.setMode("intro");
    this.locked = true;
    this.boss.passive = false;
    this.boss.startAttack("leap", 0.12);
    this.audio.setTaiko(true);
  }

  /** Skip the title and begin the fight immediately (tests). */
  startFight(): void {
    this.fightsStarted++;
    applyDifficulty(this.difficulty);
    this.hud.fightDifficulty(this.difficulty);
    this.resetActors();
    this.fightStartT = this.gameTime;
    this.fightStartDeaths = this.stats.deaths;
    this.go("fight");
    this.hud.showTitle(false);
    this.hud.hideEnd();
    this.hud.showFight(true);
    this.boss.passive = false;
    this.locked = true;
    this.cam.setMode("lock");
    this.audio.setTaiko(true);
  }

  // ------------------------------------------------------------------ fixed step

  private fixed(dt: number): void {
    this.prevP.copy(this.player.pos);
    this.prevB.copy(this.boss.pos);
    // Time scale: hitstop (real-time countdown) > slow-mo > finisher curve.
    let ts = 1;
    if (this.slowT < this.slowDur) {
      this.slowT += dt;
      ts = lerp(this.slowScale, 1, smooth(clamp(this.slowT / this.slowDur, 0, 1)));
    }
    if (this.state === "finisher" || this.state === "deathblow") ts = this.finisherScale(this.player.stateT);
    if (this.hitstop > 0) {
      this.hitstop -= dt;
      ts = 0.02;
    } else if (this.held.size && !this.pending) this.releaseHolds();
    this.timeScale = ts;
    const g = dt * ts;
    this.gameTime += g;
    this.input.clock = this.gameTime;

    // Wind builds with the fight.
    const fightK = this.state === "title" ? 0.35 : 0.55 + (1 - this.boss.health / 100) * 0.35;
    this.windK += (fightK - this.windK) * damp(0.5, dt);
    const gust = 0.75 + 0.25 * Math.sin(this.gameTime * 0.7) + 0.15 * Math.sin(this.gameTime * 2.3);
    this.wind.set(-2.6, 0.2, 1.3).multiplyScalar(this.windK * gust * 2.2);

    const p = this.player;
    const b = this.boss;
    const prompt = this.input.takePrompt();
    switch (this.state) {
      case "title":
        b.update(g, p.pos, true);
        p.update(g, null, this.cam.moveYaw, b.pos, true);
        if (prompt) this.beginIntro();
        break;
      case "fight":
        this.fight(g);
        break;
      case "deathblow":
        this.deathblow(g);
        break;
      case "finisher":
        this.finisher(g);
        break;
      case "dying":
        this.dying(g, prompt);
        break;
      case "defeat":
      case "victory":
        this.endT += dt;
        p.update(g, null, this.cam.moveYaw, b.pos, false);
        b.sense.down = this.state === "defeat";
        b.update(g, p.pos, true);
        if (!this.promptShown && this.endT > (this.state === "victory" ? 4.5 : 1.0)) {
          this.promptShown = true;
          this.hud.showPrompt();
          this.input.armPrompt("menu", 0.25);
        }
        if (prompt && this.promptShown) {
          if (this.state === "victory" || prompt === "back") this.toTitle();
          else this.beginIntro();
        }
        break;
    }

    p.step(g, this.wind, this.gameTime);
    b.step(g, this.wind, this.gameTime);
    if (this.state === "fight") this.contacts();
    this.fx.updateGame(g);
    this.drainEvents();
  }

  private fight(g: number): void {
    const p = this.player;
    const b = this.boss;
    const inp = this.input;
    if (inp.consume("lock", 0.3)) {
      this.locked = !this.locked;
      this.cam.setMode(this.locked ? "lock" : "free");
      // Target reset: unlocking puts the free camera behind the shinobi, facing the general.
      if (!this.locked) this.cam.yaw = Math.atan2(b.pos.x - p.pos.x, b.pos.z - p.pos.z);
    }
    this.runBot();

    const dist = Math.hypot(b.pos.x - p.pos.x, b.pos.z - p.pos.z);
    // A press made while still busy (mid-mikiri, mid-swing, landing) is kept for the deathblow
    // and fires as soon as the shinobi is free.
    const free = !p.busy && p.state !== "heal" && !(p.state === "mikiri" && p.stateT < 0.3);
    if (b.state === "stagger" && free && dist < DEATHBLOW_RANGE) {
      const pt = inp.peekPressTime("attack");
      if (pt !== undefined && this.gameTime - pt < 0.6 && inp.consume("attack", 0.6)) {
        if (b.markers > 1) this.startDeathblow();
        else this.startFinisher();
        return;
      }
    }
    // After a deathblow he kneels a beat, then rises for his second life.
    if (b.state === "deathblown" && b.stateT > 1.4) b.rise();

    b.sense.healing = p.healing;
    b.sense.down = false;
    b.sense.reviving = p.state === "revive";
    b.sense.airborne = p.airborne;
    p.update(g, inp, this.cam.moveYaw, b.pos, this.locked);
    b.update(g, p.pos, false);
    // Held by the throat through the throw.
    if (p.state === "thrown" && b.state === "throw") {
      const fw = _a.set(Math.sin(b.yaw), 0, Math.cos(b.yaw));
      p.pos.copy(b.pos).addScaledVector(fw, 0.95);
      p.pos.y = 0;
      p.yaw = b.yaw + Math.PI;
      p.vel.set(0, 0, 0);
      if (this.throwLanded !== b.serial && b.stateT >= cueOf(b.ch.timeline("grabThrow"), "slam", 0.72)) {
        this.throwLanded = b.serial;
        this.throwSlam();
      }
    } else this.separate();
    this.stats.maxPostureSeen = Math.max(this.stats.maxPostureSeen, b.posture);
  }

  /** Blade contacts, tested on this step's poses (after the rigs have been stepped). */
  private contacts(): void {
    const p = this.player;
    const b = this.boss;
    const inp = this.input;
    // General → player: a touch waiting on a late guard press.
    if (this.pending) {
      const pt = inp.peekPressTime("block");
      if (pt !== undefined && pt >= this.pending.t - 1e-6 && p.canGuard && inp.deflectWindow > 0) {
        const late = this.gameTime - this.pending.t;
        const h = this.pending.h;
        this.contact.copy(this.pending.at);
        this.boss.ch.rig.root.localToWorld(this.contact);
        this.pending = null;
        this.stats.lateDeflects++;
        this.perfect(h, -late);
      } else if (this.gameTime - this.pending.t > DIFFICULTY.deflectLate) {
        const h = this.pending.h;
        this.contact.copy(this.pending.at);
        this.boss.ch.rig.root.localToWorld(this.contact);
        this.pending = null;
        if (inp.isHeld("block") && p.canGuard && !h.perilous && !p.airborne) this.regular(h);
        else this.damage(h);
      }
    }
    const hi = b.activeHit();
    const peril = b.peril;
    if (hi >= 0 && !this.pending && p.state !== "dead") {
      const h = b.attack!.hits[hi];
      if (peril === "sweep") this.sweepCheck(h, hi);
      else if (peril === "grab") this.grabCheck(h, hi);
      else if (peril === "thrust" && p.state === "dodge" && p.mikiriArmed && this.facingEachOther(3.4)) {
        b.hitDone[hi] = true;
        this.mikiri(h);
      } else {
        const cr = p.ch.rig.capsule(_a, _b);
        if (this.sweep(b.ch.rig, _a, _b, cr)) {
          b.hitDone[hi] = true;
          this.stats.contactErr.push(+(h.contact - b.stateT).toFixed(3));
          if (h.perilous === "thrust" && p.state === "dodge" && p.mikiriArmed) this.mikiri(h);
          else if (p.invulnerable) {
            this.stats.dodged++;
            this.nearMiss(!!h.perilous);
          }
          else {
            this.holdAtContact(b.ch, _a, _b, cr);
            this.resolveBossHit(h);
          }
        }
      }
    }
    // A grab that closed on nothing.
    if (peril === "grab" && b.attack && this.grabSeen !== b.serial && b.stateT > b.attack.hits[0].t1) {
      this.grabSeen = b.serial;
      this.stats.grabsEvaded++;
    }

    // Player → general.
    if (p.swingActive && b.hittable) {
      const cr = b.ch.rig.capsule(_a, _b);
      if (this.sweep(p.ch.rig, _a, _b, cr + 0.05)) {
        p.swingHit = true;
        this.holdAtContact(p.ch, _a, _b, cr + 0.05);
        this.resolvePlayerHit();
      }
    }

    // Outside live strikes neither blade may rest inside the other fighter (a blocked
    // follow-through, a close-range idle stance): lift it clear.
    let r = p.ch.rig.capsule(_a, _b);
    let d = segSegDist(b.ch.rig.hiltW, b.ch.rig.tipW, _a, _b, _c1, _c2) - r;
    this.avoidB = !b.strikeSoon && !this.pending && d < (this.avoidB ? AVOID_RELEASE : AVOID_GAP);
    b.ch.setAvoid(this.avoidB);
    r = b.ch.rig.capsule(_a, _b);
    d = segSegDist(p.ch.rig.hiltW, p.ch.rig.tipW, _a, _b, _c1, _c2) - r;
    this.avoidP = !p.strikeSoon && d < (this.avoidP ? AVOID_RELEASE : AVOID_GAP);
    p.ch.setAvoid(this.avoidP);
  }

  /** Within `reach` and roughly face to face (the mikiri needs the step straight into the blade). */
  private facingEachOther(reach: number): boolean {
    const p = this.player;
    const b = this.boss;
    const dx = p.pos.x - b.pos.x;
    const dz = p.pos.z - b.pos.z;
    const d = Math.hypot(dx, dz);
    if (d > reach || d < 1e-3) return false;
    const off = Math.abs(Math.atan2(Math.sin(Math.atan2(dx, dz) - b.yaw), Math.cos(Math.atan2(dx, dz) - b.yaw)));
    return off < 0.7;
  }

  /** In front of him (within `arc` rad of his facing) and within `reach`. */
  private inFront(reach: number, arc: number): boolean {
    const p = this.player;
    const b = this.boss;
    const dx = p.pos.x - b.pos.x;
    const dz = p.pos.z - b.pos.z;
    const d = Math.hypot(dx, dz);
    if (d > reach) return false;
    const a = Math.atan2(dx, dz) - b.yaw;
    return Math.abs(Math.atan2(Math.sin(a), Math.cos(a))) < arc;
  }

  /** Perilous sweep: everything on the roof in its arc is cut; only being in the air (or out of reach) clears it. */
  private sweepCheck(h: HitDef, hi: number): void {
    const p = this.player;
    const b = this.boss;
    if (!this.inFront(3.1, 1.9)) return;
    // Over it (the rewarded answer: kick off his head next), or through it on step-dodge i-frames.
    if (p.airborne || (p.invulnerable && p.state === "dodge")) {
      if (this.sweepSeen !== b.serial) {
        this.sweepSeen = b.serial;
        if (p.airborne) this.stats.sweepsJumped++;
        else this.stats.dodged++;
        this.nearMiss(true);
        this.audio.whoosh(true, "boss"); // [audio hook] the sweep passing under / past her
      }
      // Dodged through: the blade has passed. (In the air he can still land into it.)
      if (!p.airborne) b.hitDone[hi] = true;
      return;
    }
    if (p.state === "dead" || p.state === "revive" || p.state === "thrown" || p.state === "mikiri") return;
    b.hitDone[hi] = true;
    this.contact.copy(p.pos).setY(0.3);
    this.damage(h);
  }

  /** Perilous grab: closes on anyone in front of him who isn't dodging or airborne. */
  private grabCheck(h: HitDef, hi: number): void {
    const p = this.player;
    const b = this.boss;
    // The hand closes around the contact: a dodge whose i-frames cover it gets clean away.
    if (b.stateT < h.contact - 0.08 || b.stateT > h.contact + 0.05 || !this.inFront(2.1, 0.8)) return;
    if (p.invulnerable || p.pos.y > 0.5 || p.state === "dead") return;
    b.hitDone[hi] = true;
    this.grabSeen = b.serial;
    this.stats.grabbed++;
    this.pending = null;
    this.releaseHolds();
    b.throwing();
    p.thrownBy();
    this.fx.glyph.hide();
    this.audio.grab();
    this.cam.shake(0.25);
  }

  private throwSlam(): void {
    const p = this.player;
    const h = ATTACKS.grab.hits[0];
    this.stats.hitsTaken++;
    this.stats.hitLog.push(`thrown ${this.boss.phase}`);
    p.health = Math.max(0, p.health - h.dmg * DIFFICULTY.playerDamage);
    p.posture = Math.min(99, p.posture + h.posture * 0.5);
    p.postureIdle = 0;
    this.contact.copy(p.ch.rig.chestW);
    this.fx.slam(p.pos);
    this.fx.wound(this.contact, _a.set(0, 1, 0));
    this.audio.throwSlam();
    this.cam.shake(0.6);
    this.post.hitFlash(0.25, 0x6a0c08);
    this.hitstop = 0.07;
    if (p.health <= 0) this.killPlayer();
  }

  private nearMissSeen = -1;
  private postureHot = false;

  /**
   * A dodge's i-frames carried her through a live blade (the blade touched her): a beat of slow-mo
   * (0.15 s at 0.35×, a little longer for a perilous move), a faint cool flash, the whiff cue. Once per
   * attack, never on top of another slow-mo.
   */
  private nearMiss(perilous: boolean): void {
    const b = this.boss;
    if (this.nearMissSeen === b.serial) return;
    this.nearMissSeen = b.serial;
    this.stats.nearMisses++;
    if (this.slowT >= this.slowDur) {
      this.slowT = 0;
      this.slowDur = perilous ? 0.18 : 0.13;
      this.slowScale = 0.35;
    }
    this.post.hitFlash(perilous ? 0.07 : 0.05, 0x8fa6c0);
    this.audio.nearMiss();
  }

  private mikiri(h: HitDef): void {
    const p = this.player;
    const b = this.boss;
    this.stats.mikiri++;
    wavedash.achieve("MIKIRI");
    this.pending = null;
    this.releaseHolds();
    p.yaw = Math.atan2(b.pos.x - p.pos.x, b.pos.z - p.pos.z);
    p.mikiri();
    b.mikiried();
    b.posture += MIKIRI_POSTURE;
    b.postureIdle = 0;
    const at = b.ch.rig.tipW.clone().lerp(b.ch.rig.hiltW, 0.35);
    at.y = Math.max(0.08, at.y * 0.3);
    this.contact.copy(at);
    this.fx.deflect(at, this.sparkDir(at, new THREE.Vector3()), 1.2);
    this.fx.slam(p.pos.clone().lerp(b.pos, 0.45));
    this.fx.glyph.hide();
    this.audio.mikiri();
    this.cam.shake(0.45);
    this.cam.punch(0.8);
    this.post.hitFlash(0.14);
    this.post.kickAberration(1);
    this.hitstop = 0.09;
    this.slowT = 0;
    this.slowDur = 0.55;
    this.slowScale = 0.35;
    if (b.posture >= 100) this.postureBreak("posture");
    void h;
  }

  private kick(): void {
    const p = this.player;
    const b = this.boss;
    this.stats.kicks++;
    const onHead = b.peril === "sweep" && b.hittable;
    const at = b.ch.rig.headW.clone();
    if (!b.hittable) return;
    if (onHead) {
      this.stats.headKicks++;
      wavedash.achieve("HEAD_KICK");
      b.posture += KICK_HEAD_POSTURE;
      b.kicked();
      this.fx.armour(at, _a.subVectors(at, p.pos).normalize(), 40);
      this.audio.kick(true);
      this.cam.shake(0.4);
      this.hitstop = 0.06;
      this.slowT = 0;
      this.slowDur = 0.45;
      this.slowScale = 0.4;
    } else {
      b.posture += KICK_BODY_POSTURE;
      this.fx.armour(b.ch.rig.chestW, _a.subVectors(b.ch.rig.chestW, p.pos).normalize(), 16);
      this.audio.kick(false);
      this.cam.shake(0.15);
    }
    b.postureIdle = 0;
    if (b.posture >= 100) this.postureBreak("posture");
  }

  private separate(): void {
    const p = this.player;
    const b = this.boss;
    if (b.pos.y > 0.6 || p.pos.y > 0.9) return;
    const dx = p.pos.x - b.pos.x;
    const dz = p.pos.z - b.pos.z;
    const d = Math.hypot(dx, dz);
    const min = 1.05;
    if (d < min && d > 1e-4) {
      const push = min - d;
      p.pos.x += (dx / d) * push * 0.8;
      p.pos.z += (dz / d) * push * 0.8;
      b.pos.x -= (dx / d) * push * 0.2;
      b.pos.z -= (dz / d) * push * 0.2;
      p.confine();
    }
  }

  /**
   * Swept blade (previous → current step) against a capsule, tested as interpolated blade
   * segments no more than SWEEP_STEP apart so a fast cut can't slip between samples. Records
   * the first touching fraction (`touchS`) and the touch point on the blade (`touch`).
   */
  private sweep(rig: FighterRig, ca: THREE.Vector3, cb: THREE.Vector3, r: number): boolean {
    const travel = Math.max(rig.tipW.distanceTo(rig.prevTipW), rig.hiltW.distanceTo(rig.prevHiltW));
    const n = clamp(Math.ceil(travel / SWEEP_STEP), 1, 24);
    for (let k = 0; k <= n; k++) {
      const u = k / n;
      _s0.lerpVectors(rig.prevHiltW, rig.hiltW, u);
      _s1.lerpVectors(rig.prevTipW, rig.tipW, u);
      if (segSegDist(_s0, _s1, ca, cb, _c1, _c2) < r) {
        this.touchS = u;
        this.touch.copy(_c1);
        return true;
      }
    }
    return false;
  }

  /** Test hook: the previous sweep, which combat.mjs checks the sub-stepped one against. */
  legacySweep(rig: FighterRig, ca: THREE.Vector3, cb: THREE.Vector3, r: number): boolean {
    let best = Infinity;
    for (const [s0, s1] of [
      [rig.hiltW, rig.tipW],
      [rig.prevHiltW, rig.prevTipW],
      [rig.prevTipW, rig.tipW],
    ] as const)
      best = Math.min(best, segSegDist(s0, s1, ca, cb, _c1, _c2));
    const m0 = _s0.lerpVectors(rig.prevHiltW, rig.prevTipW, 0.55);
    const m1 = _s1.lerpVectors(rig.hiltW, rig.tipW, 0.55);
    return Math.min(best, segSegDist(m0, m1, ca, cb, _c1, _c2)) < r;
  }

  /** Test hook for the sweep. */
  sweepTest(rig: FighterRig, ca: THREE.Vector3, cb: THREE.Vector3, r: number): { hit: boolean; s: number } {
    const hit = this.sweep(rig, ca, cb, r);
    return { hit, s: this.touchS };
  }

  /** The player squares up to the general and brings the blade through the contact point. */
  private playerMeets(): void {
    const p = this.player;
    const b = this.boss;
    p.yaw = Math.atan2(b.pos.x - p.pos.x, b.pos.z - p.pos.z);
    p.ch.guardAt(this.contact);
    // Re-pose now so no rendered frame shows the blades apart.
    p.step(0, this.wind, this.gameTime);
  }

  private sparkDir(p: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    const toCam = _a.subVectors(this.camera.position, p).normalize();
    const fromBoss = _b.subVectors(this.player.pos, this.boss.pos).setY(0).normalize();
    return out.copy(toCam).multiplyScalar(0.55).addScaledVector(fromBoss, 0.6).add(new THREE.Vector3(0, 0.35, 0)).normalize();
  }

  private resolveBossHit(h: HitDef): void {
    const p = this.player;
    const inp = this.input;
    if (p.canGuard) {
      const pt = inp.peekPressTime("block");
      if (pt !== undefined && this.gameTime - pt <= Math.min(DIFFICULTY.deflectEarly, inp.deflectWindow)) return this.perfect(h, this.gameTime - pt);
      // A thrust goes straight through a raised guard (only a deflect turns it); in the air only
      // a deflect works too.
      if (inp.isHeld("block") && !h.perilous && !p.airborne) return this.regular(h);
      // Kept in the general's frame: his root still moves (leap descent, lunge) while his pose is held.
      this.pending = { h, t: this.gameTime, predicted: h.contact, at: this.boss.ch.rig.root.worldToLocal(this.contact.clone()) };
      return;
    }
    this.damage(h);
  }

  private perfect(h: HitDef, early: number): void {
    const p = this.player;
    const b = this.boss;
    this.input.consume("block", 10);
    this.input.resetMash();
    this.stats.deflects++;
    this.stats.timings.push(+early.toFixed(3));
    this.deflectChain = this.gameTime - this.lastDeflectT < DEFLECT_CHAIN_GAP ? this.deflectChain + 1 : 0;
    this.lastDeflectT = this.gameTime;
    const at = this.contact.clone();
    const out = this.sparkDir(at, new THREE.Vector3());
    this.playerMeets();
    const heavy = !!h.heavy || !!h.perilous;
    this.hitstop = HITSTOP_DEFLECT + (heavy ? 0.01 : 0);
    this.fx.deflect(at, out, heavy ? 1.3 : 1);
    this.audio.clang(heavy ? 1 : 0.88);
    this.cam.shake(heavy ? 0.3 : 0.22);
    this.post.kickAberration(heavy ? 0.9 : 0.6);
    this.post.hitFlash(heavy ? 0.16 : 0.12);
    b.posture += deflectPosture(h, this.deflectChain);
    b.postureIdle = 0;
    b.guarded = true;
    // A deflect costs a little posture but never breaks it.
    p.posture = Math.min(99, p.posture + 3);
    p.postureIdle = 0;
    // Already mid-flick from the press: keep it, the guard layer carries the blade to the contact.
    // In the air the jump carries on (the guard layer alone turns the blade).
    if (!p.airborne && p.state !== "jump" && p.state !== "kick") {
      p.enter("deflect");
      if (p.ch.clipName !== "deflect") p.setClip("deflect", 0.03);
    }
    const a = b.attack;
    const last = !a || a.hits.indexOf(h) === a.hits.length - 1;
    if (b.posture >= 100) this.postureBreak("posture");
    else if (last && !b.hasFollow) b.recoil();
    // The rebound also steers the recoil / stagger crossfades clear of the player.
    b.ch.bounce();
  }

  private regular(h: HitDef): void {
    const p = this.player;
    this.stats.blocks++;
    const at = this.contact.clone();
    this.playerMeets();
    // A blocked final blow keeps the rebound until the follow-through is over.
    const a = this.boss.attack;
    const last = !a || a.hits.indexOf(h) === a.hits.length - 1;
    this.boss.ch.bounce(last && a ? clamp(a.dur - this.boss.stateT - 0.55, 0, 0.6) : 0);
    this.boss.guarded = true;
    this.hitstop = HITSTOP_BLOCK;
    this.fx.block(at, this.sparkDir(at, new THREE.Vector3()));
    this.audio.blockThud();
    this.cam.shake(0.18);
    p.posture += h.posture * DIFFICULTY.blockPosture;
    p.postureIdle = 0;
    this.boss.posture += 3;
    this.boss.postureIdle = 0;
    if (p.posture >= 100) {
      p.posture = 100;
      p.guardBreak();
      this.audio.guardBreak();
      this.cam.shake(0.45);
      this.post.hitFlash(0.12, 0xff7040);
    } else {
      p.enter("block");
      p.setClip("block", 0.04);
    }
    if (this.boss.posture >= 100) this.postureBreak("posture");
  }

  private damage(h: HitDef): void {
    const p = this.player;
    this.stats.hitsTaken++;
    const pt = this.input.peekPressTime("block");
    this.stats.hitLog.push(`${p.state}@${p.stateT.toFixed(2)} ${this.boss.attack?.name ?? "?"} press-${pt === undefined ? "none" : (this.gameTime - pt).toFixed(3)} win=${this.input.deflectWindow.toFixed(3)}`);
    // A broken posture leaves him wide open: hits land harder.
    const k = p.state === "guardbreak" ? 1.5 : 1;
    p.health = Math.max(0, p.health - h.dmg * k * DIFFICULTY.playerDamage);
    p.posture = Math.min(99, p.posture + 8);
    p.postureIdle = 0;
    const at = this.contact.clone();
    this.fx.wound(at, _a.subVectors(p.pos, this.boss.pos).setY(0.3).normalize());
    this.audio.hurt();
    this.cam.shake(0.5);
    this.post.hitFlash(0.25, 0x6a0c08);
    this.post.kickAberration(1);
    this.hitstop = 0.06;
    if (p.health <= 0) this.killPlayer();
    else p.takeHit(this.boss.pos);
  }

  private resolvePlayerHit(): void {
    const p = this.player;
    const b = this.boss;
    const sw = p.swing!;
    const at = this.contact.clone();
    const out = _a.subVectors(p.pos, b.pos).setY(0.5).normalize().clone();
    b.postureIdle = 0;
    if (b.state === "attack") {
      // Committed to a swing: armoured through it, he takes it without flinching (and keeps coming).
      b.health -= sw.dmg * 0.45;
      b.posture += sw.posture * DIFFICULTY.cutPostureArmoured;
      this.audio.hitAccent();
      this.stats.playerHits++;
      this.fx.armour(at, out, 30);
      this.audio.hitFlesh(true);
      this.hitstop = 0.035;
      this.cam.shake(0.12);
    } else if (OPEN.has(b.state) || b.state === "stagger" || ((b.state === "idle" || b.state === "wait") && !sw.charged && b.slips())) {
      // In an opening (or his idle guard slipped): the cut lands in full.
      b.health -= sw.dmg;
      b.posture += sw.posture * DIFFICULTY.cutPostureOpen;
      this.audio.hitAccent();
      this.stats.playerHits++;
      this.fx.armour(at, out, 50);
      this.audio.hitFlesh(true);
      this.hitstop = 0.05;
      this.cam.shake(0.2);
      if (b.state !== "stagger" && !b.cutInOpening() && (b.state === "flinch" || b.state === "recover" || b.state === "whiff" || b.state === "idle" || b.state === "wait")) b.flinch();
    } else if (b.state === "idle" || b.state === "block" || b.state === "wait") {
      b.yaw = Math.atan2(p.pos.x - b.pos.x, p.pos.z - b.pos.z);
      b.ch.guardAt(at);
      if (sw.charged) {
        // A charged cut drives through his guard: chip vitality and heavy posture.
        b.enter("block");
        b.setClip("block", 0.05);
        b.step(0, this.wind, this.gameTime);
        b.health -= sw.dmg * 0.35;
        b.posture += sw.posture;
        this.stats.bossBlocks++;
        p.ch.bounce();
        this.fx.armour(at, out, 36);
        this.audio.clang(0.5);
        this.audio.hitFlesh(false);
        this.hitstop = 0.05;
        this.cam.shake(0.22);
      } else {
        const r = b.guard();
        b.step(0, this.wind, this.gameTime);
        if (r === "block") {
          this.stats.bossBlocks++;
          b.posture += 3;
          p.ch.bounce();
          this.fx.armour(at, out, 26);
          this.audio.clang(0.32);
          this.hitstop = 0.035;
          this.cam.shake(0.12);
        } else {
          // He turns the cut aside (no posture cost to the player, but a long recoil) and
          // answers with the flurry.
          this.stats.bossDeflects++;
          this.fx.deflect(at, this.sparkDir(at, new THREE.Vector3()), 0.55);
          this.audio.clang(0.75);
          this.hitstop = 0.06;
          this.cam.shake(0.28);
          p.ch.bounce();
          p.deflected();
          b.counter();
        }
      }
    } else return;
    if (b.health <= 0) {
      b.health = 0;
      this.postureBreak("vitality");
    } else if (b.posture >= 100) this.postureBreak("posture");
  }

  private postureBreak(kind: "posture" | "vitality"): void {
    const b = this.boss;
    // Already open for the deathblow: more cuts don't restart the window.
    if (b.state === "stagger") return;
    if (kind === "posture") b.posture = 100;
    b.stagger(kind);
    this.pending = null;
    this.stats.breaks++;
    this.fx.dot.active = true;
    this.fx.breakBurst(b.ch.rig.chestW);
    this.fx.glyph.hide();
    this.audio.drum(true);
    this.cam.shake(0.8);
    this.cam.punch(1.4);
    this.post.hitFlash(0.22, 0xff5a20);
    this.post.kickAberration(1.4);
    this.slowT = 0;
    this.slowDur = 0.9;
    this.slowScale = 0.28;
  }

  // ------------------------------------------------------------------ death and resurrection

  private killPlayer(): void {
    const p = this.player;
    p.die();
    this.pending = null;
    this.releaseHolds();
    this.go("dying");
    this.stats.deaths++;
    this.audio.deathSting();
    this.audio.setTaiko(false);
    this.cam.setMode("death");
    this.desatTarget = 0.65;
    this.fx.glyph.hide();
    this.hud.showFight(false);
    this.slowT = 0;
    this.slowDur = 1.2;
    this.slowScale = 0.35;
  }

  private dying(g: number, prompt: "confirm" | "back" | null): void {
    const p = this.player;
    const b = this.boss;
    this.endT += g / Math.max(this.timeScale, 1e-3);
    p.update(g, null, this.cam.moveYaw, b.pos, false);
    b.sense.down = true;
    b.sense.healing = false;
    b.update(g, p.pos, true);
    if (!this.promptShown && this.endT > DEATH_BEAT) {
      this.promptShown = true;
      if (p.rez > 0) {
        this.hud.showDeath();
        this.input.armPrompt("menu", 0.5);
      } else return this.trueDeath();
    }
    if (prompt && this.promptShown) {
      if (prompt === "confirm") this.resurrect();
      else this.trueDeath();
    }
  }

  /** Rise again on the spot: the general keeps his vitality, posture and marker. */
  resurrect(): void {
    const p = this.player;
    if (p.rez <= 0) return;
    this.go("fight");
    p.revive();
    this.stats.resurrections++;
    this.input.flush();
    this.input.resetMash();
    this.hud.hideEnd();
    this.hud.showFight(true);
    this.desatTarget = 0;
    this.cam.setMode(this.locked ? "lock" : "free");
    this.audio.revive();
    this.audio.setTaiko(true);
    this.fx.inkBurst(p.pos.clone().setY(0.6), new THREE.Vector3(0, 1, 0));
    this.boss.cooldown = Math.max(this.boss.cooldown, 1.6);
  }

  private trueDeath(): void {
    this.go("defeat");
    this.stats.defeats++;
    this.hud.showEnd("defeat");
    this.audio.setTaiko(false);
    this.desatTarget = 0.65;
  }

  // ------------------------------------------------------------------ deathblows

  /** Slow-motion curve keyed to the plunge event (shorter for the first-marker deathblow). */
  private finisherScale(t: number): number {
    const short = this.state === "deathblow";
    t -= (this.finTl?.plunge ?? 0.43) - (short ? 0.3 : 0.43);
    if (short) {
      if (t < 0.26) return 1;
      if (t < 0.34) return lerp(1, 0.3, smooth((t - 0.26) / 0.08));
      if (t < 0.6) return 0.3;
      if (t < 0.8) return lerp(0.3, 1, smooth((t - 0.6) / 0.2));
      return 1;
    }
    if (t < 0.34) return 1;
    if (t < 0.44) return lerp(1, 0.18, smooth((t - 0.34) / 0.1));
    if (t < 0.78) return 0.18;
    if (t < 1.05) return lerp(0.18, 1, smooth((t - 0.78) / 0.27));
    return 1;
  }

  /** Put both fighters in place for a deathblow animation. */
  private placeForDeathblow(clip: "deathblow" | "finisher"): void {
    const p = this.player;
    const b = this.boss;
    const dir = _a.subVectors(p.pos, b.pos).setY(0);
    if (dir.lengthSq() < 1e-4) dir.set(0, 0, 1);
    dir.normalize();
    b.yaw = Math.atan2(dir.x, dir.z);
    b.vel.set(0, 0, 0);
    p.pos.copy(b.pos).addScaledVector(dir, 1.22);
    p.pos.y = 0;
    p.vel.set(0, 0, 0);
    p.vy = 0;
    p.yaw = Math.atan2(-dir.x, -dir.z);
    p.enter(clip);
    p.setClip(clip, 0.12);
    this.finTl = p.ch.timeline(clip);
    // Both fighters were placed: nothing to interpolate from their old spots.
    this.prevP.copy(p.pos);
    this.prevB.copy(b.pos);
    this.pending = null;
    this.releaseHolds();
    // The plunge is meant to go through him (a skinned blade is driven into his chest), and the
    // cloth starts from the new spots.
    p.ch.plungeInto?.(b.ch.rig.chestW);
    p.ch.resetCloth();
    b.ch.resetCloth();
    p.ch.setAvoid(false);
    b.ch.setAvoid(false);
    this.fx.dot.active = false;
    this.fx.glyph.hide();
    this.finPlunged = false;
    this.finInk2 = false;
  }

  /** First marker: a short deathblow, he kneels, then rises for phase 2. */
  startDeathblow(): void {
    const b = this.boss;
    this.go("deathblow");
    this.placeForDeathblow("deathblow");
    b.enter("finished");
    this.cam.setMode("finisher");
    this.barsTarget = 0.55;
    this.audio.setDuck(0.6);
    this.stats.deathblows++;
    wavedash.achieve("FIRST_DEATHBLOW");
  }

  private deathblow(g: number): void {
    const p = this.player;
    const b = this.boss;
    p.update(g, null, this.cam.moveYaw, b.pos, false);
    b.update(g, p.pos, true);
    const t = p.stateT;
    const tl = this.finTl!;
    if (!this.finPlunged && t >= tl.plunge) {
      this.finPlunged = true;
      b.deathblown();
      this.plungeFx(0.75);
      this.audio.deathblow();
      this.hud.markerTaken(b.markers);
    }
    if (!this.finInk2 && t >= tl.withdraw) {
      this.finInk2 = true;
      this.withdrawFx();
    }
    if (t >= tl.end) {
      // Back to the fight while he kneels; he rises a beat later (fight() calls rise()).
      this.go("fight");
      p.enter("move");
      p.setClip("idle", 0.2);
      this.cam.setMode(this.locked ? "lock" : "free");
      this.barsTarget = 0;
      this.desatTarget = 0;
      this.audio.setDuck(1);
      this.hud.showFight(true);
    }
  }

  startFinisher(): void {
    const b = this.boss;
    this.go("finisher");
    this.placeForDeathblow("finisher");
    b.enter("finished");
    this.cam.setMode("finisher");
    this.hud.showFight(false);
    this.barsTarget = 1;
    this.audio.setTaiko(false);
    this.audio.setDuck(0.35);
    this.stats.finishers++;
    this.stats.deathblows++;
  }

  private plungeFx(power: number): void {
    const p = this.player;
    const b = this.boss;
    const chest = b.ch.rig.chestW.clone();
    const through = _a.subVectors(b.pos, p.pos).setY(0).normalize().clone();
    const toCam = _b.subVectors(this.camera.position, chest).setY(0).normalize();
    const spray = through.clone().multiplyScalar(0.55).addScaledVector(toCam, 0.45).add(new THREE.Vector3(0, 0.75, 0)).normalize();
    this.fx.inkBurst(chest.clone().addScaledVector(through, 0.1), spray);
    this.cam.shake(0.55 * power);
    this.post.hitFlash(0.4 * power, 0x3a0000);
    this.post.kickAberration(1.2 * power);
    this.desatTarget = 0.5 * power;
  }

  private withdrawFx(): void {
    const p = this.player;
    const b = this.boss;
    const chest = b.ch.rig.chestW.clone();
    const back = _a.subVectors(p.pos, b.pos).setY(0).normalize();
    const side = new THREE.Vector3(back.z, 0.6, -back.x).normalize();
    this.fx.inkBurst(chest, side.addScaledVector(back, 0.4).normalize());
    this.cam.shake(0.2);
    this.audio.whoosh(true);
  }

  private finisher(g: number): void {
    const p = this.player;
    const b = this.boss;
    p.update(g, null, this.cam.moveYaw, b.pos, false);
    b.update(g, p.pos, true);
    const t = p.stateT;
    const tl = this.finTl!;
    if (!this.finPlunged && t >= tl.plunge) {
      this.finPlunged = true;
      b.health = 0;
      b.markers = 0;
      b.setClip("finished", 0.05);
      this.plungeFx(1);
      this.audio.finisher();
      this.hud.markerTaken(0);
    }
    if (!this.finInk2 && t >= tl.withdraw) {
      this.finInk2 = true;
      this.withdrawFx();
    }
    if (t >= tl.end) {
      this.go("victory");
      this.stats.victory = true;
      wavedash.submitScore(`victory-${this.difficulty}`, (this.gameTime - this.fightStartT) * 1000);
      wavedash.achieve("VICTORY");
      if (this.difficulty === "hard") wavedash.achieve("VICTORY_HARD");
      if (this.stats.deaths === this.fightStartDeaths) wavedash.achieve("NO_DEATH");
      this.desatTarget = 0.65;
      this.hud.showEnd("victory");
      this.cam.setMode("victory");
      p.enter("victory");
      p.setClip("victory", 0.4);
      b.enter("dead");
      this.audio.setDuck(0.7);
    }
  }

  // ------------------------------------------------------------------ events → sound / fx

  private drainEvents(): void {
    const au = this.audio;
    for (const e of this.player.events) {
      if (e === "step") au.footstep(2.5);
      else if (e === "stepRun") au.footstep(6);
      else if (e === "dodge") {
        au.dodge(this.player.dodgeSide);
        this.fx.kickPuff(this.player.pos);
      } else if (e === "dodgeLand") au.dodgeLand();
      else if (e === "swing") au.whoosh(false);
      else if (e === "swingHeavy") au.whoosh(true);
      else if (e === "land") au.land();
      else if (e === "jump") au.jump();
      else if (e === "kick") {
        if (this.state === "fight" && this.boss.hittable && this.inFront(KICK_REACH + 0.6, Math.PI)) this.kick();
      } else if (e === "drink") {
        this.stats.heals++;
        au.drink();
        au.gourdTick();
      } else if (e === "sip") au.sip();
      else if (e === "gourdEmpty") au.gourdEmpty();
      else if (e === "safetyRoll") au.dodge();
    }
    this.player.events.length = 0;
    // His posture climbing into the danger zone: one warning per crossing.
    const hot = this.boss.posture >= 80 && this.boss.state !== "stagger";
    if (hot && !this.postureHot) this.audio.postureWarn();
    this.postureHot = this.boss.posture >= 72 ? this.postureHot || hot : false;
    const tip = this.boss.ch.rig.tipW;
    for (const e of this.boss.events) {
      if (e === "step") au.bossStep();
      else if (e === "glint") {
        this.fx.glint(tip);
        au.glint();
      } else if (e === "peril") {
        this.fx.glyph.show();
        const head = this.player.ch.rig.headW;
        this.fx.glint(head.clone().setY(head.y + 0.35), true);
        au.peril();
      } else if (e === "whoosh") au.whoosh(false, "boss"); // [audio hook]
      else if (e === "whooshHeavy") au.whoosh(true, "boss"); // [audio hook]
      else if (e === "leapOff") au.dodge();
      else if (e === "slam") {
        this.fx.slam(this.boss.pos);
        au.slam();
        const d = this.boss.pos.distanceTo(this.player.pos);
        this.cam.shake(clamp(0.5 - d * 0.05, 0.1, 0.45));
      } else if (e === "recover") this.fx.dot.active = false;
      else if (e === "punish") this.stats.punishes++;
      else if (e === "rise") {
        au.bossRise();
        this.fx.breakBurst(this.boss.ch.rig.chestW);
        this.cam.shake(0.35);
        this.hud.phase(2);
      }
    }
    this.boss.events.length = 0;
  }

  // ------------------------------------------------------------------ bot

  private runBot(): void {
    const bot = this.bot;
    const inp = this.input;
    const b = this.boss;
    const p = this.player;
    if (bot.releaseAt > 0 && this.gameTime >= bot.releaseAt) {
      inp.release("block");
      inp.release("dodge");
      inp.release("jump");
      inp.release("heal");
      bot.releaseAt = -1;
      if (!bot.play) inp.botAxis = null;
    }
    if (!bot.deflect && !bot.play) return;
    if (bot.attackId !== b.serial) {
      bot.attackId = b.serial;
      bot.pressed = [];
      bot.plan = (b.attack?.hits ?? []).map(() => ({ off: (this.botRand() * 2 - 1) * bot.jitter, miss: this.botRand() < bot.miss }));
    }
    const tap = (a: "block" | "dodge" | "jump" | "heal", hold = 0.1) => {
      inp.press(a);
      bot.releaseAt = this.gameTime + hold;
    };
    if (bot.deflect && b.state === "attack" && b.attack) {
      // Phase 2 runs faster: the bot's lead is in the general's clip time.
      const k = b.tempo;
      b.attack.hits.forEach((h, i) => {
        if (bot.pressed[i]) return;
        const pl = bot.plan[i] ?? { off: 0, miss: false };
        if (pl.miss) return;
        const soon = (lead: number) => b.stateT >= h.contact - (lead + pl.off) * k;
        if (h.perilous === "thrust") {
          if (soon(0.22)) {
            bot.pressed[i] = true;
            const side = bot.sidestep > 0 && ((b.serial * 7) % 10) / 10 < bot.sidestep;
            inp.botAxis = side ? { x: 1, y: 0 } : { x: 0, y: 1 };
            tap("dodge");
          }
        } else if (h.perilous === "sweep") {
          if (soon(0.3)) {
            bot.pressed[i] = true;
            inp.botAxis = null;
            tap("jump");
            // Over the blade, then off his head once it has passed underneath.
            bot.kickAt = h.contact + 0.05;
          }
        } else if (h.perilous === "grab") {
          if (soon(0.26)) {
            bot.pressed[i] = true;
            inp.botAxis = { x: 1, y: 0 };
            tap("dodge");
          }
        } else if (soon(bot.lead)) {
          bot.pressed[i] = true;
          tap("block");
        }
      });
    }
    // Kick off his head on the way over the sweep.
    if (bot.kickAt > 0 && (b.state !== "attack" || b.stateT >= bot.kickAt)) {
      bot.kickAt = -1;
      if (p.state === "jump") {
        inp.press("jump");
        inp.release("jump");
      }
    }
    if (bot.play) {
      const d = Math.hypot(b.pos.x - p.pos.x, b.pos.z - p.pos.z);
      const dodging = bot.releaseAt > 0 && inp.botAxis && (inp.botAxis.x !== 0 || inp.botAxis.y !== 0);
      if (!dodging) {
        if (b.state === "stagger") inp.botAxis = d > 2.4 ? { x: 0, y: 1 } : null;
        else inp.botAxis = (b.state === "idle" || OPEN.has(b.state)) && d > 3.0 ? { x: 0, y: 1 } : null;
      }
      // One sip: while he rises for his second life (he can't punish it), or when hurt and clear.
      const safe = b.state === "rise" || (b.state === "idle" && d > 3.2 && b.cooldown > 0.6);
      if (!bot.healed && p.state === "move" && p.gourd > 0 && safe && (b.state === "rise" || p.health < 55)) {
        bot.healed = true;
        tap("heal");
      }
      if (this.gameTime >= bot.nextSwing && p.state !== "heal") {
        if (b.state === "stagger" && d < 3.2) {
          inp.press("attack");
          inp.release("attack");
          bot.nextSwing = this.gameTime + 0.3;
        } else if (OPEN.has(b.state) && d < 3.2) {
          inp.press("attack");
          inp.release("attack");
          bot.nextSwing = this.gameTime + 0.28;
        } else if (b.state === "idle" && d < 2.8) {
          inp.press("attack");
          inp.release("attack");
          bot.nextSwing = this.gameTime + 1.4;
        }
      }
    }
  }

  // ------------------------------------------------------------------ frame

  /** Render interpolation offset (previous → current fixed step) for each fighter. */
  readonly interp = { p: new THREE.Vector3(), b: new THREE.Vector3() };
  private readonly prevP = new THREE.Vector3();
  private readonly prevB = new THREE.Vector3();
  private readonly camP = new THREE.Vector3();
  private readonly camB = new THREE.Vector3();
  private readonly camPC = new THREE.Vector3();
  private readonly camBC = new THREE.Vector3();

  frame(dt: number, render: boolean, alpha = 1): void {
    this.realTime += dt;
    this.input.realClock = this.realTime;
    const mouse = this.input.takeMouse();
    const p = this.player;
    const b = this.boss;
    // The camera frames the fighters where they are drawn (interpolated), not the raw sim steps.
    const k = 1 - clamp(alpha, 0, 1);
    this.interp.p.subVectors(this.prevP, p.pos).multiplyScalar(k);
    this.interp.b.subVectors(this.prevB, b.pos).multiplyScalar(k);
    const ip = this.camP.addVectors(p.pos, this.interp.p);
    const ib = this.camB.addVectors(b.pos, this.interp.b);
    const ipc = this.camPC.addVectors(p.ch.rig.chestW, this.interp.p);
    const ibc = this.camBC.addVectors(b.ch.rig.chestW, this.interp.b);
    this.cam.update(dt, ip, ipc, ib, ibc, mouse);
    this.camera.updateMatrixWorld();
    RIM.uSunView.value.copy(SUN_DIR).transformDirection(this.camera.matrixWorldInverse);

    this.fx.updateReal(dt);
    // The danger glyph flashes over the shinobi's head.
    this.fx.glyph.update(dt, _a.copy(p.ch.rig.headW).add(this.interp.p).setY(p.ch.rig.headW.y + 0.55), this.camera);
    const dotAt = _b.copy(b.ch.rig.chestW).addScaledVector(_c1.subVectors(this.camera.position, b.ch.rig.chestW).normalize(), 0.35);
    this.fx.dot.update(dt, dotAt);
    // Trails run on game time so hitstop freezes them with the blades.
    this.playerBody.frame(dt * this.timeScale);
    this.bossBody.frame(dt * this.timeScale * b.tempo);
    this.snow.update(this.realTime, this.camera.position, this.windK, window.innerHeight * Math.min(window.devicePixelRatio, 1.5));
    this.arena.update(dt, this.windK);

    const au = this.audio;
    au.intensity = this.state === "title" ? 0.1 : this.state === "fight" ? 0.45 + (1 - b.health / 100) * 0.4 + b.posture / 400 + (b.phase === 2 ? 0.1 : 0) : 0.35;
    au.taikoTempo = 76 + (1 - b.health / 100) * 44 + (b.posture > 70 ? 10 : 0) + (b.phase === 2 ? 14 : 0);
    au.scene(this.state, this.camera, p.pos, b.pos, b.phase, p.state === "attack" && !!p.swing?.charged && p.stateT < p.swing.whoosh); // [audio hook]
    au.update(dt);

    this.post.desat += (this.desatTarget - this.post.desat) * damp(3, dt);
    // End screens: the scene dims ~40% while the brush word paints on.
    const dimTo = this.state === "victory" || this.state === "defeat" || (this.state === "dying" && this.endT > 0.9) ? 0.4 : 0;
    this.post.fade += (dimTo - this.post.fade) * damp(6, dt);
    this.post.bars += (this.barsTarget - this.post.bars) * damp(4, dt);
    const pf = p.health / PLAYER_MAX.health;
    this.hud.update(
      dt,
      { health: b.health, posture: b.posture, broken: b.state === "stagger", markers: b.markers, limited: vitalityRegen(b.health / BOSS_MAX.health) < 0.5 },
      { health: p.health, posture: p.posture, gourd: p.gourd, rez: p.rez, limited: vitalityRegen(pf) < 0.5 },
    );

    if (render) {
      this.playerBody.beginRender(this.interp.p);
      this.bossBody.beginRender(this.interp.b);
      this.post.render(dt);
      this.playerBody.endRender();
      this.bossBody.endRender();
    }
    this.frames++;
    this.fpsT += dt;
    if (this.fpsT >= 0.5) {
      this.fps = this.frames / this.fpsT;
      this.frames = 0;
      this.fpsT = 0;
    }
  }

  // ------------------------------------------------------------------ bodies

  private readonly nextBody: Partial<Record<"player" | "boss", Fighter>> = {};

  /** Put a fighter on another body (a loaded SkinnedCharacter); applied between fights. */
  useBody(who: "player" | "boss", body: Fighter): void {
    this.nextBody[who] = body;
    if (this.state === "title") this.applyBodies();
  }

  private applyBodies(): void {
    for (const who of ["player", "boss"] as const) {
      const b = this.nextBody[who];
      if (!b) continue;
      delete this.nextBody[who];
      (who === "player" ? this.playerBody : this.bossBody).swap(b);
    }
  }

  // ------------------------------------------------------------------ test hooks

  pause(): void {
    this.paused = true;
    this.loop.stop();
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.loop.start();
  }

  /** Advance deterministically: 2 fixed steps per simulated 60 Hz frame; renders once at the end. */
  step(seconds: number): void {
    const frames = Math.max(1, Math.round(seconds * 60));
    for (let i = 0; i < frames; i++) {
      this.fixed(FIXED_DT);
      this.fixed(FIXED_DT);
      this.frame(1 / 60, i === frames - 1);
    }
  }

  forceBossAttack(name: string): void {
    if (!ATTACKS[name]) return;
    this.boss.startAttack(name);
  }

  /** Test hook: skip straight to the general's second life. */
  forcePhase2(): void {
    const b = this.boss;
    b.markers = 1;
    b.rise();
    b.stateT = 2.2;
    b.health = BOSS_MAX.health;
    this.hud.markerTaken(1);
    this.hud.phase(2);
  }

  /** Put the fighters at a given distance, facing each other. */
  place(dist: number): void {
    this.boss.pos.set(0, 0, -2);
    this.boss.yaw = 0;
    this.player.pos.set(0, 0, -2 + dist);
    this.player.yaw = Math.PI;
    this.player.vel.set(0, 0, 0);
    this.boss.vel.set(0, 0, 0);
    this.prevP.copy(this.player.pos);
    this.prevB.copy(this.boss.pos);
  }
}
