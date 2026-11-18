/**
 * The general's brain. Every attack is data: hit windows (with the expected contact time the
 * deflect bot aims at), glint times, tracking windows (he turns to follow you during wind-ups
 * and commits at the strike), and root-motion lunges capped so he never runs through you.
 *
 * Two lives (deathblow markers). Phase 1 is a guarded swordsman; after the first deathblow he
 * rises at full vitality for phase 2: faster strings, the five-swipe flurry, more perilous
 * attacks, shorter pauses. He punishes the gourd, deflects blade spam and answers with the
 * flurry, and chains follow-ups (leap → thrust / sweep, flurry → thrust, combo → grab).
 */
import * as THREE from "three";
import { approachAngle, clamp, damp, rng } from "../core/math";
import type { Timeline } from "../chars/animEvents";
import type { Fighter } from "../chars/Fighter";
import { ARENA_HALF, RIDGE_Z } from "../world/Arena";
import { vitalityRegen } from "./Player";
import { DIFFICULTY } from "./difficulty";

export type Peril = "thrust" | "sweep" | "grab";

/** Gameplay data of one blow; its timing comes from the animation events. */
export interface HitSpec {
  dmg: number;
  posture: number;
  perilous?: Peril;
  heavy?: boolean;
}

export interface HitDef extends HitSpec {
  t0: number;
  t1: number;
  contact: number;
}

interface MoveSpec {
  d: number;
  /** Stop this far from the player. */
  stop: number;
}

interface Move extends MoveSpec {
  a: number;
  b: number;
}

export interface AttackSpec {
  name: string;
  hits: HitSpec[];
  /** One per lunge window in the clip's events. */
  moves: MoveSpec[];
  perilous?: Peril;
  leap?: boolean;
}

/** An attack as it runs: gameplay spec + the active body's event timeline. */
export interface AttackDef extends AttackSpec {
  clip: string;
  dur: number;
  hits: HitDef[];
  moves: Move[];
  glints: number[];
  whoosh: number[];
  track: [number, number][];
  leapOff: number;
  slam: number;
}

const COMBO_MOVES: MoveSpec[] = [
  { d: 2.2, stop: 1.45 },
  { d: 1.0, stop: 1.7 },
  { d: 1.3, stop: 1.6 },
];

export const ATTACKS: Record<string, AttackSpec> = {
  // Three blows on a ~0.37 s cadence.
  combo: {
    name: "combo",
    hits: [
      { dmg: 14, posture: 14 },
      { dmg: 14, posture: 14 },
      { dmg: 18, posture: 18, heavy: true },
    ],
    // The opening lunge closes to 1.45 m (up to 2.2 m of travel): from 1.7 m the first cut fell short.
    moves: COMBO_MOVES,
  },
  // Two quick blows, then the third hangs ~0.85 s after the second to punish early taps.
  comboDelay: {
    name: "comboDelay",
    hits: [
      { dmg: 14, posture: 14 },
      { dmg: 14, posture: 14 },
      { dmg: 20, posture: 20, heavy: true },
    ],
    moves: COMBO_MOVES,
  },
  overhead: {
    name: "overhead",
    hits: [{ dmg: 24, posture: 26, heavy: true }],
    moves: [
      { d: 0.6, stop: 2.2 },
      { d: 1.4, stop: 1.6 },
    ],
  },
  // Perilous thrust: the glyph appears at t = 0 and the thrust lands ~0.9 s later.
  // Can't be guarded; deflect, mikiri (step into it) or sidestep.
  thrust: {
    name: "thrust",
    perilous: "thrust",
    hits: [{ dmg: 26, posture: 30, perilous: "thrust" }],
    moves: [{ d: 4.8, stop: 0.9 }],
  },
  // ~0.82 s airborne from takeoff to the slam.
  leap: {
    name: "leap",
    leap: true,
    hits: [{ dmg: 22, posture: 24, heavy: true }],
    moves: [],
  },
  // Perilous sweep at the ankles: jump it (and kick off his head), or be out of reach.
  sweep: {
    name: "sweep",
    perilous: "sweep",
    hits: [{ dmg: 24, posture: 20, perilous: "sweep" }],
    moves: [{ d: 1.4, stop: 1.5 }],
  },
  // Perilous grab: step dodge or jump; he is left open when it misses. Damage lands on the throw.
  grab: {
    name: "grab",
    perilous: "grab",
    hits: [{ dmg: 30, posture: 25, perilous: "grab" }],
    moves: [{ d: 3.2, stop: 0.95 }],
  },
  // Five swipes, the last one delayed: phase 2's string, and his answer to deflected spam.
  flurry: {
    name: "flurry",
    hits: [
      { dmg: 11, posture: 11 },
      { dmg: 11, posture: 11 },
      { dmg: 11, posture: 11 },
      { dmg: 11, posture: 11 },
      { dmg: 18, posture: 18, heavy: true },
    ],
    moves: [
      { d: 2.0, stop: 1.5 },
      { d: 0.7, stop: 1.6 },
      { d: 0.7, stop: 1.6 },
      { d: 0.7, stop: 1.6 },
      { d: 1.2, stop: 1.55 },
    ],
  },
};

export function buildAttack(spec: AttackSpec, tl: Timeline): AttackDef {
  const n = Math.min(spec.hits.length, tl.hits.length);
  return {
    ...spec,
    clip: spec.name,
    dur: tl.end,
    hits: spec.hits.slice(0, n).map((h, i) => ({ ...h, t0: tl.hits[i].start, t1: tl.hits[i].end, contact: tl.hits[i].contact })),
    moves: spec.moves.slice(0, tl.lunge.length).map((m, i) => ({ ...m, a: tl.lunge[i][0], b: tl.lunge[i][1] })),
    glints: tl.windupPeak,
    whoosh: tl.whoosh.slice(0, n),
    track: tl.track,
    leapOff: tl.leapOff,
    slam: tl.slam,
  };
}

export type BState =
  | "idle"
  | "attack"
  | "block"
  | "recoil"
  | "flinch"
  | "stagger"
  | "recover"
  | "whiff"
  | "mikiried"
  | "kicked"
  | "throw"
  | "deathblown"
  | "rise"
  | "finished"
  | "dead"
  | "wait"
  | "stunned";

/** States in which his guard is down: player cuts land in full and flinch him. */
export const OPEN: ReadonlySet<BState> = new Set<BState>(["recoil", "flinch", "recover", "whiff", "mikiried", "kicked", "stunned"]);

export const BOSS_MAX = { health: 100, posture: 100, markers: 2 };
/** Seconds the deathblow stays available after a break. */
export const DEATHBLOW_WINDOW = 4.0;
/** Inside HEAL_CLOSE he reacts to the gourd at once (from range after DIFFICULTY.healReact). */
const HEAL_CLOSE = 2.6;
/** Rising for the second life takes this long (he is back on the player within ~1.5-2 s). */
const RISE_T = 1.6;

/** What the general can see of the player this step (set by the game). */
export interface PlayerSense {
  healing: boolean;
  down: boolean;
  reviving: boolean;
  airborne: boolean;
}

/** Pick from normalized weights with r in [0, 1); "idle" = no attack this time. */
function weighted(w: Record<string, number>, r: number): string | null {
  const total = Object.values(w).reduce((a, b) => a + b, 0);
  let acc = 0;
  for (const [k, v] of Object.entries(w)) {
    acc += v / total;
    if (r < acc) return k === "idle" ? null : k;
  }
  return null;
}

export class Boss {
  readonly pos = new THREE.Vector3(0, 0, -4.5);
  readonly vel = new THREE.Vector3();
  yaw = 0;
  health = BOSS_MAX.health;
  posture = 0;
  postureIdle = 0;
  state: BState = "wait";
  stateT = 0;
  attack: AttackDef | null = null;
  hitDone: boolean[] = [];
  cooldown = 1.2;
  phase: 1 | 2 = 1;
  /** Deathblow markers left (lives). */
  markers = BOSS_MAX.markers;
  /** What broke him: a full posture bar or an empty vitality bar. */
  breakKind: "posture" | "vitality" = "posture";
  guardHits = 0;
  /** Increments with every attack started (lets the test bot track attack instances). */
  serial = 0;
  /** The player guarded (blocked / deflected) a blow of the current attack. */
  guarded = false;
  sense: PlayerSense = { healing: false, down: false, reviving: false, airborne: false };
  /** Animation / attack tempo of this step (phase 2 attacks run faster). */
  tempo = 1;
  private time = 0;
  /** Cuts taken in the current opening: after DIFFICULTY.openHits he breaks out of it. */
  private openHits = 0;
  /** How long the current `recover` opening lasts. */
  private recoverFor = 0.6;
  /** How long the current `stunned` opening lasts (firecrackers, losing her to the crow step). */
  private stunFor = 1;
  /** Stunned by the crow step: he turns to where she went (slowly), not where she is. */
  private stunTurn = 0;
  /** Answer to a deflected cut, started after DIFFICULTY.counterDelay on guard. */
  private pendingCounter: string | null = null;
  private lastGuardT = -9;
  private punishedHeal = false;
  private healSeen = 0;
  private follow: string | null = null;
  private followAt = 0;
  private strafe = 1;
  private strafeT = 0;
  private lastAttack = "";
  private queue: string[] = [];
  private moveAllow: number[] = [];
  private fallV = 0;
  private leapFrom = new THREE.Vector3();
  private leapTo = new THREE.Vector3();
  private clipNow = "";
  private R = rng(9);
  readonly events: string[] = [];
  /** Freeze the brain (title screen, scripted shots). */
  passive = false;

  constructor(readonly ch: Fighter) {
    ch.rig.onStep = () => this.events.push("step");
  }

  reset(): void {
    this.pos.set(0, 0, -4.5);
    this.vel.set(0, 0, 0);
    this.fallV = 0;
    this.yaw = 0;
    this.health = BOSS_MAX.health;
    this.posture = 0;
    this.postureIdle = 0;
    this.phase = 1;
    this.markers = BOSS_MAX.markers;
    this.state = "wait";
    this.stateT = 0;
    this.attack = null;
    this.cooldown = 0.1;
    this.guardHits = 0;
    this.lastAttack = "";
    this.follow = null;
    this.pendingCounter = null;
    this.recoverFor = 0.6;
    this.punishedHeal = false;
    this.tempo = 1;
    this.queue = ["leap", "combo", "thrust", "comboDelay", "overhead", "sweep"];
    this.R = rng(9);
    this.events.length = 0;
    this.clipNow = "";
    this.setClip("idle", 0);
  }

  setClip(name: string, fade = 0.15, t0 = 0): void {
    this.clipNow = name;
    this.ch.play(name, fade, t0);
  }

  enter(s: BState): void {
    this.state = s;
    this.stateT = 0;
  }

  get attackT(): number {
    return this.state === "attack" ? this.stateT : -1;
  }

  /** The perilous kind of the running attack, if any. */
  get peril(): Peril | null {
    return this.state === "attack" && this.attack?.perilous ? this.attack.perilous : null;
  }

  /** Swing window (for trails / whoosh): any hit window open. */
  activeHit(): number {
    if (this.state !== "attack" || !this.attack) return -1;
    const h = this.attack.hits;
    for (let i = 0; i < h.length; i++) if (!this.hitDone[i] && this.stateT >= h[i].t0 && this.stateT <= h[i].t1) return i;
    return -1;
  }

  /** A blow that hasn't landed is winding up (within 0.2 s) or live: its blade must not be steered. */
  get strikeSoon(): boolean {
    if (this.state !== "attack" || !this.attack) return false;
    const t = this.stateT;
    return this.attack.hits.some((h, i) => !this.hitDone[i] && t >= h.t0 - 0.2 && t <= h.t1);
  }

  /** A follow-up attack is lined up (a deflected last blow doesn't knock him out of the string). */
  get hasFollow(): boolean {
    return !!this.follow;
  }

  /** He can be cut / kicked / deathblown (not while rising, falling or already finished). */
  get hittable(): boolean {
    return this.state !== "rise" && this.state !== "deathblown" && this.state !== "finished" && this.state !== "dead" && this.state !== "throw";
  }

  startAttack(name: string, t0 = 0): void {
    this.pendingCounter = null;
    const a = buildAttack(ATTACKS[name], this.ch.timeline(name));
    this.serial++;
    this.attack = a;
    this.hitDone = a.hits.map(() => false);
    this.moveAllow = a.moves.map(() => -1);
    this.guarded = false;
    this.follow = this.pickFollow(name);
    this.followAt = this.follow && a.hits.length ? a.hits[a.hits.length - 1].t1 + 0.4 : Infinity;
    this.enter("attack");
    this.stateT = t0;
    this.setClip(a.clip, 0.12, t0);
    this.lastAttack = name;
    if (a.perilous) this.events.push("peril");
  }

  /** Strings: what (if anything) comes straight after this attack. Decided when it starts. */
  private pickFollow(name: string): string | null {
    const r = this.R();
    const p2 = this.phase === 2;
    if (name === "leap") {
      if (p2) return r < 0.35 ? "flurry" : r < 0.65 ? "sweep" : r < 0.9 ? "thrust" : null;
      // Phase 1: thrust follow-ups, sweeps only once he is hurt (~3:1).
      if (r < 0.45) return "thrust";
      if (r < 0.6) return this.health < 60 ? "sweep" : "thrust";
      return null;
    }
    if (name === "flurry" && p2) return r < 0.35 ? "thrust" : null;
    if (name === "combo" && p2) return r < 0.25 ? "grab" : null;
    if (name === "comboDelay" && p2) return r < 0.2 ? "sweep" : null;
    return null;
  }

  private choose(dist: number): string | null {
    const q = this.queue.shift();
    if (q) {
      if (q === "leap" && dist < 4.5) return "combo";
      if (q !== "leap" && q !== "thrust" && dist > 4.4) return dist > 6 ? "leap" : "thrust";
      return q;
    }
    const r = this.R();
    const p2 = this.phase === 2;
    const peril = (n: string) => n === "thrust" || n === "sweep" || n === "grab";
    let pick: string | null;
    if (dist > 6.5) pick = r < 0.6 ? "leap" : r < 0.85 ? "thrust" : null;
    else if (dist > 4.4) pick = r < 0.4 ? "thrust" : r < 0.7 ? "leap" : p2 && r < 0.85 ? "grab" : null;
    else if (!p2) {
      pick = weighted(DIFFICULTY.picks.p1, r);
    } else {
      pick = weighted(DIFFICULTY.picks.p2, r);
    }
    // No two perilous attacks back to back (outside strings), and don't repeat himself too much.
    if (pick && peril(pick) && peril(this.lastAttack)) pick = p2 ? "flurry" : "combo";
    if (pick && pick === this.lastAttack && this.R() < 0.6) pick = pick === "combo" || pick === "comboDelay" ? "overhead" : p2 ? "flurry" : "combo";
    return pick;
  }

  /** Punishing the gourd from range: phase 1 closes with a slam / string, phase 2 dives in with the thrust. */
  private punish(dist: number): string {
    if (this.phase === 2) return "thrust";
    // The combo's opening lunge falls short from ~3 m on a retreating drinker: leap in instead.
    return dist > 2.9 ? "leap" : "combo";
  }

  update(dt: number, player: THREE.Vector3, playerDown: boolean): void {
    this.tempo = this.state === "attack" ? DIFFICULTY.tempo[this.phase - 1] : 1;
    dt *= this.tempo;
    this.time += dt;
    this.stateT += dt;
    this.postureIdle += dt;
    const s0 = this.state;
    const noRegen =
      s0 === "attack" || s0 === "stagger" || s0 === "mikiried" || s0 === "kicked" || s0 === "finished" || s0 === "deathblown" || s0 === "rise" || s0 === "throw" || s0 === "dead";
    if (!noRegen && this.postureIdle > 0.25) {
      this.posture = Math.max(0, this.posture - dt * DIFFICULTY.bossRegen * vitalityRegen(this.health / BOSS_MAX.health));
    }
    const sense = this.sense;
    const down = playerDown || sense.down;
    if (!sense.healing) {
      this.punishedHeal = false;
      this.healSeen = 0;
    }
    const to = new THREE.Vector3().subVectors(player, this.pos).setY(0);
    const dist = to.length();
    const face = Math.atan2(to.x, to.z);
    const fwd = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    let want = new THREE.Vector3();

    switch (this.state) {
      case "wait":
        if (!this.passive) this.enter("idle");
        break;
      case "idle": {
        this.yaw = approachAngle(this.yaw, face, dt * 4.5);
        this.strafeT -= dt;
        if (this.strafeT <= 0) {
          this.strafe = this.R() < 0.5 ? -1 : 1;
          this.strafeT = 1.2 + this.R() * 1.5;
        }
        const side = new THREE.Vector3(to.z, 0, -to.x).normalize().multiplyScalar(this.strafe);
        if (down) {
          // The shinobi fell: step back and wait, blade lowered (he keeps his vitality and posture).
          want = dist < 5.5 ? to.clone().normalize().multiplyScalar(-1.3) : side.multiplyScalar(0.4);
          this.cooldown = Math.max(this.cooldown, 1.1);
        } else if (dist > 3.6) want = to.clone().normalize().multiplyScalar(dist > 6 ? (this.phase === 2 ? 3.2 : 2.6) : 1.7).addScaledVector(side, 0.3);
        else if (dist < 2.0) want = to.clone().normalize().multiplyScalar(-1.2);
        else want = side.multiplyScalar(this.phase === 2 ? 1.2 : 0.9);
        this.vel.lerp(want, damp(5, dt));
        const clip = this.vel.length() > 0.4 ? "walk" : "idle";
        if (this.clipNow !== clip && this.clipNow !== "guard") this.setClip(clip, 0.3);
        if (!down && !this.passive && !sense.reviving) {
          // He sees the gourd come up and goes for it after a reaction beat: point blank it
          // lands; from range the dive can be met (mikiri) once the swallow is done.
          if (sense.healing && !this.punishedHeal) {
            this.healSeen += dt;
            const close = dist < HEAL_CLOSE;
            if (close || this.healSeen >= DIFFICULTY.healReact) {
              this.punishedHeal = true;
              // In his face: a cut straight from the guard that lands before the swallow.
              if (close) this.startAttack("combo", DIFFICULTY.healCloseStart);
              else this.startAttack(this.punish(dist));
              this.events.push("punish");
              break;
            }
          }
          this.cooldown -= dt;
          if (this.cooldown <= 0) {
            const a = this.choose(dist);
            if (a) this.startAttack(a);
            else this.cooldown = 0.35;
          }
        }
        break;
      }
      case "attack": {
        const a = this.attack!;
        const t = this.stateT;
        const prevT = t - dt;
        const tracking = a.track.some(([s, e]) => t >= s && t <= e);
        if (tracking) this.yaw = approachAngle(this.yaw, face, dt * 6);
        for (const g of a.glints) if (prevT < g && t >= g) this.events.push("glint");
        for (let i = 0; i < a.whoosh.length; i++) {
          if (prevT < a.whoosh[i] && t >= a.whoosh[i] && a.perilous !== "grab") this.events.push(a.hits[i].heavy ? "whooshHeavy" : "whoosh");
        }
        want.set(0, 0, 0);
        let lunging = false;
        a.moves.forEach((m, i) => {
          if (t >= m.a && t < m.b) {
            if (this.moveAllow[i] < 0) this.moveAllow[i] = clamp(dist - m.stop, 0, m.d);
            // Eased so the lunge covers exactly its allowance and ends at rest, `stop` from the
            // player (a constant speed chased by a filter coasted ~0.5 m into him).
            const u = (t - m.a) / (m.b - m.a);
            want.copy(fwd).multiplyScalar((this.moveAllow[i] * 6 * u * (1 - u)) / (m.b - m.a));
            lunging = true;
          }
        });
        if (a.leap) {
          const off = a.leapOff;
          const land = a.slam;
          if (prevT < off && t >= off) {
            this.leapFrom.copy(this.pos);
            const d = clamp(dist - 1.5, 1.5, 9.5);
            this.leapTo.copy(this.pos).addScaledVector(to.clone().normalize(), d);
            this.yaw = face;
            this.events.push("leapOff");
          }
          if (t >= off && t <= land) {
            const u = (t - off) / (land - off);
            const e = u * u * (3 - 2 * u) * 0.35 + u * 0.65;
            this.pos.lerpVectors(this.leapFrom, this.leapTo, e);
            this.pos.y = Math.sin(u * Math.PI) * 2.9;
            want.set(0, 0, 0);
            this.vel.set(0, 0, 0);
          }
          if (prevT < land && t >= land) {
            this.pos.y = 0;
            this.events.push("slam");
          }
        }
        if (lunging) this.vel.copy(want);
        else this.vel.lerp(want, damp(10, dt));
        // A grab that closed on nothing leaves him reaching, open.
        if (a.perilous === "grab" && a.hits.length && t > a.hits[0].t1 + 0.04) {
          this.opened();
          this.attack = null;
          this.enter("whiff");
          this.setClip("whiff", 0.2);
          this.cooldown = 0.3;
          break;
        }
        if (this.follow && t >= this.followAt && !down) {
          const f = this.follow;
          this.follow = null;
          this.startAttack(f);
          break;
        }
        if (t >= a.dur) {
          // Spent: he stands open for a beat (cuts land), then circles before the next attack.
          this.attack = null;
          this.enter("recover");
          this.recoverFor = DIFFICULTY.recoverAfterAttack[this.phase - 1];
          this.setClip("idle", 0.25);
          const g = this.phase === 2 ? DIFFICULTY.gap.p2 : DIFFICULTY.gap.p1;
          this.cooldown = g[0] + this.R() * g[1];
        }
        break;
      }
      case "block":
        this.vel.multiplyScalar(Math.exp(-dt * 8));
        this.yaw = approachAngle(this.yaw, face, dt * 5);
        if (this.pendingCounter) {
          // Turned a cut aside: a beat on guard, then the answer.
          if (this.stateT >= DIFFICULTY.counterDelay) {
            const c = this.pendingCounter;
            this.pendingCounter = null;
            this.startAttack(c);
          }
        } else if (this.stateT > 0.36) {
          this.enter("idle");
          this.setClip("guard", 0.15);
          this.clipNow = "guard";
          this.cooldown = Math.min(this.cooldown, 0.5);
        }
        break;
      case "recoil":
        this.vel.lerp(fwd.clone().multiplyScalar(-1.2), damp(6, dt));
        if (this.stateT > DIFFICULTY.recoilT) this.backToIdle(0.35 + this.R() * 0.35);
        break;
      case "flinch":
        this.vel.multiplyScalar(Math.exp(-dt * 8));
        if (this.stateT > 0.4) this.backToIdle(Math.min(this.cooldown, 0.3));
        break;
      case "whiff":
        this.vel.multiplyScalar(Math.exp(-dt * 6));
        if (this.stateT > 0.9) this.backToIdle(0.3);
        break;
      case "mikiried":
        this.vel.multiplyScalar(Math.exp(-dt * 10));
        if (this.stateT > 1.6) this.backToIdle(0.3);
        break;
      case "kicked":
        this.vel.lerp(fwd.clone().multiplyScalar(-1.5), damp(6, dt));
        if (this.stateT > 1.0) this.backToIdle(0.3);
        break;
      case "throw":
        this.vel.set(0, 0, 0);
        if (this.stateT > 1.9) this.backToIdle(0.6);
        break;
      case "stagger":
        this.vel.multiplyScalar(Math.exp(-dt * 6));
        if (this.stateT > DEATHBLOW_WINDOW) {
          // Missed the deathblow: he recovers a little and the fight goes on.
          if (this.breakKind === "posture") this.posture = 70;
          else this.health = Math.max(this.health, 15);
          this.enter("recover");
          this.recoverFor = 0.6;
          this.setClip("staggerEnd", 0.2);
          this.events.push("recover");
        }
        break;
      case "stunned":
        this.vel.multiplyScalar(Math.exp(-dt * 7));
        if (this.stunTurn > 0) this.yaw = approachAngle(this.yaw, face, dt * this.stunTurn);
        // He shakes it off and answers (Sekiro: a stun is an opening, not a free fight): guard up,
        // turn to her, then the long string. Deflect it and the stun paid twice; mash and you eat it.
        if (this.stateT > this.stunFor) {
          if (this.passive) this.backToIdle(0.35);
          else this.counter();
        }
        break;
      case "recover":
        this.vel.multiplyScalar(Math.exp(-dt * 6));
        if (this.stateT > this.recoverFor) {
          const cd = this.cooldown;
          this.backToIdle(Math.max(0.3, cd));
          if (this.phase === 2) this.cooldown = Math.max(0.3, cd);
        }
        break;
      case "rise": {
        this.vel.set(0, 0, 0);
        this.yaw = approachAngle(this.yaw, face, dt * 2);
        const u = clamp(this.stateT / 1.2, 0, 1);
        this.health = BOSS_MAX.health * u;
        this.posture = 0;
        if (this.stateT > RISE_T) {
          this.health = BOSS_MAX.health;
          this.backToIdle(0.15);
        }
        break;
      }
      case "deathblown":
      case "finished":
      case "dead":
        this.vel.set(0, 0, 0);
        break;
    }

    // Knocked out of the leap's scripted flight (deflect → recoil, a counter): drop to the roof.
    const flying = this.state === "attack" && !!this.attack?.leap && this.stateT <= this.attack.slam;
    if (this.pos.y > 0 && !flying) {
      this.fallV += 18 * dt;
      this.pos.y = Math.max(0, this.pos.y - this.fallV * dt);
    }
    if (this.pos.y <= 0) this.fallV = 0;
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;
    this.pos.x = clamp(this.pos.x, -ARENA_HALF, ARENA_HALF);
    this.pos.z = clamp(this.pos.z, RIDGE_Z + 1.4, ARENA_HALF);
  }

  private backToIdle(cooldown: number): void {
    this.attack = null;
    this.enter("idle");
    this.setClip("idle", 0.2);
    this.cooldown = this.phase === 2 ? cooldown * 0.6 : cooldown;
  }

  /**
   * The player's blade met his guard. Returns "block" | "deflect". A string of cuts gets turned
   * aside more and more often (phase 1 guards more than phase 2).
   */
  guard(): "block" | "deflect" {
    if (this.time - this.lastGuardT > 1.3) this.guardHits = 0;
    this.lastGuardT = this.time;
    this.guardHits++;
    this.postureIdle = 0;
    const D = DIFFICULTY.bossDeflect;
    const chance = D[Math.min(this.guardHits, D.length - 1)] * (this.phase === 2 ? 0.85 : 1);
    if (this.R() < chance) {
      this.guardHits = 0;
      return "deflect";
    }
    this.enter("block");
    this.setClip("block", 0.05);
    return "block";
  }

  /** Answer to a deflected cut: the long string. */
  counter(): void {
    // After a beat on guard, from the top of the string (its glint included): the first blow can
    // be deflected. Half the time it's the flurry, else the three-cut combo.
    this.attack = null;
    this.follow = null;
    this.pendingCounter = this.R() < DIFFICULTY.counterFlurry ? "flurry" : "combo";
    this.enter("block");
    this.setClip("guard", 0.1);
  }

  /**
   * A cut met his idle guard: the first (or second) cut of a string sometimes slips through
   * (DIFFICULTY.guardSlip). Counts toward the string like a guarded cut.
   */
  slips(): boolean {
    if (this.time - this.lastGuardT > 1.3) this.guardHits = 0;
    const p = DIFFICULTY.guardSlip[Math.min(this.guardHits, 1)] ?? 0;
    if (this.guardHits >= 2 || this.R() >= p) return false;
    this.guardHits++;
    this.lastGuardT = this.time;
    return true;
  }

  /**
   * A cut landed while his guard was down. Two in one opening and he breaks out: phase 1 gets
   * his guard back up, phase 2 answers straight away. Returns true when he broke out.
   */
  cutInOpening(): boolean {
    this.openHits++;
    if (this.openHits < DIFFICULTY.openHits || this.state === "stagger") return false;
    this.openHits = 0;
    if (this.phase === 2) {
      const q = this.queue[0];
      if (q && q !== "leap") this.startAttack(this.queue.shift()!);
      else this.startAttack(this.R() < 0.6 ? "flurry" : "grab");
    }
    else {
      this.attack = null;
      this.enter("block");
      this.setClip("block", 0.06);
      this.cooldown = Math.min(this.cooldown, 0.4);
    }
    return true;
  }

  private opened(): void {
    this.openHits = 0;
  }

  recoil(): void {
    this.opened();
    this.attack = null;
    this.follow = null;
    this.enter("recoil");
    this.setClip("recoil", 0.14);
  }

  flinch(): void {
    this.enter("flinch");
    this.setClip("flinch", 0.05);
  }

  /** Can an ability interrupt him right now (not while broken, kneeling, rising or throwing)? */
  get stunnable(): boolean {
    const s = this.state;
    return s !== "stagger" && s !== "deathblown" && s !== "rise" && s !== "throw" && s !== "finished" && s !== "dead" && s !== "wait";
  }

  /**
   * Knocked out of whatever he was doing and open for `t` seconds: the firecrackers (he reels,
   * `turn` 0), or the crow step (he lost her and turns to find her at `turn` rad/s).
   */
  stun(t: number, clip = "flinch", turn = 0): void {
    this.opened();
    this.attack = null;
    this.follow = null;
    this.pendingCounter = null;
    this.pos.y = 0;
    this.stunFor = t;
    this.stunTurn = turn;
    this.enter("stunned");
    this.setClip(clip, 0.06);
  }

  /** Stomped by the mikiri counter. */
  mikiried(): void {
    this.opened();
    this.attack = null;
    this.follow = null;
    this.enter("mikiried");
    this.setClip("mikiried", 0.04);
  }

  /** Kicked off (on his head during a sweep). */
  kicked(): void {
    this.opened();
    this.attack = null;
    this.follow = null;
    this.pos.y = 0;
    this.enter("kicked");
    this.setClip("kicked", 0.05);
  }

  /** The grab closed on the shinobi. */
  throwing(): void {
    this.attack = null;
    this.follow = null;
    this.vel.set(0, 0, 0);
    this.enter("throw");
    this.setClip("grabThrow", 0.05);
  }

  stagger(kind: "posture" | "vitality" = "posture"): void {
    this.attack = null;
    this.follow = null;
    this.breakKind = kind;
    this.pos.y = 0;
    this.enter("stagger");
    this.setClip("stagger", 0.1);
  }

  /** A deathblow took a marker: kneel until the game has him rise for the next life. */
  deathblown(): void {
    this.markers--;
    this.attack = null;
    this.follow = null;
    this.enter("deathblown");
    this.setClip("deathblown", 0.05);
  }

  /** Second life: full vitality (filled while he rises), posture reset, the phase-2 moveset. */
  rise(): void {
    this.phase = 2;
    this.posture = 0;
    this.guardHits = 0;
    this.queue = ["thrust", "sweep", "flurry", "grab", "combo"];
    this.enter("rise");
    this.setClip("rise", 0.2);
    this.events.push("rise");
  }

  step(dt: number, wind: THREE.Vector3, t: number): void {
    this.ch.rig.root.position.copy(this.pos);
    this.ch.rig.yaw = this.yaw;
    this.ch.rig.vel.copy(this.vel);
    this.ch.step(dt * this.tempo, wind, t);
    const a = this.attack;
    this.ch.trail.emitting =
      this.state === "attack" && !!a && a.perilous !== "grab" && a.hits.some((h, i) => (!this.hitDone[i] || this.stateT < h.t1) && this.stateT > h.t0 - 0.06 && this.stateT < h.t1);
  }
}
