/**
 * Player controller: movement relative to the camera, lock-on strafing, step dodge with
 * i-frames (hold to sprint), a 3-hit combo (hold attack for a charged cut), guard / deflect,
 * jump with an air cut and a kick off the general, the healing gourd, the mikiri stomp, hit
 * reactions, guard break (with a safety roll), death, resurrection and the deathblows.
 *
 * Cancel windows: after a swing's cut (its hit window has closed) guard, dodge and jump cancel
 * the recovery; the end of a step dodge can be cancelled into an attack, guard or jump.
 */
import * as THREE from "three";
import type { Action, Input } from "../core/Input";
import { approachAngle, clamp, damp } from "../core/math";
import { cueOf } from "../chars/animEvents";
import type { Fighter } from "../chars/Fighter";
import { ARENA_HALF, RIDGE_Z } from "../world/Arena";
import { ABILITY, Abilities, type AbilityId } from "./Abilities";
import { DIFFICULTY } from "./difficulty";

export type PState =
  | "move"
  | "dodge"
  | "attack"
  | "airAttack"
  | "deflect"
  | "block"
  | "hit"
  | "guardbreak"
  | "jump"
  | "kick"
  | "heal"
  | "mikiri"
  | "thrown"
  | "dead"
  | "revive"
  | "deathblow"
  | "finisher"
  | "victory"
  | "tool"
  | "crow";

/** Gameplay data of one swing; its timing comes from the animation events. */
export interface SwingSpec {
  clip: string;
  dmg: number;
  posture: number;
  heavy?: boolean;
  /** Can't be turned aside by his guard (a charged cut). */
  charged?: boolean;
}

export interface SwingDef extends SwingSpec {
  t0: number;
  t1: number;
  dur: number;
  chain: number;
  whoosh: number;
}

export const SWINGS: SwingSpec[] = [
  { clip: "attack1", dmg: 6, posture: 5 },
  { clip: "attack2", dmg: 6, posture: 5 },
  { clip: "attack3", dmg: 9, posture: 9, heavy: true },
];
export const CHARGED: SwingSpec = { clip: "attackC", dmg: 11, posture: 16, heavy: true, charged: true };
export const AIR_CUT: SwingSpec = { clip: "jumpAtk", dmg: 9, posture: 12, heavy: true };

/** Radius within which a raised guard turns to face the general even without lock-on. */
const GUARD_FACE = 8;

export const PLAYER_MAX = { health: 100, posture: 100 };
/** Healing gourd: charges per fight (not refilled by resurrection), share of max vitality per sip, seconds it takes. */
export const GOURD = {
  get charges(): number {
    return DIFFICULTY.gourdCharges;
  },
  heal: 0.45,
  over: 0.35,
};
/** Resurrections per fight, and the vitality share you rise with. */
export const REZ = { charges: 1, health: 0.5 };
/** Guard can be raised again this far into a hit reaction. */
const HIT_GUARD = 0.2;
/** Invulnerable this long after getting back up. */
const REVIVE_GRACE = 0.6;

/** How long a press waits to fire when the player is busy (recovery, hitstun, a swing). */
export const BUFFER = { attack: 0.35, dodge: 0.3, jump: 0.25, heal: 0.3, block: 0.12, ability: 0.3 };

const ABILITY_KEYS: readonly [Action, AbilityId][] = [
  ["ability1", "curse"],
  ["ability2", "crackers"],
  ["ability3", "crow"],
];

/** Posture regen (DIFFICULTY.playerPostureRegen per second) starts after POSTURE_DELAY without posture damage. */
const POSTURE_DELAY = 1.0;
/** Holding guard greatly speeds posture recovery. */
const GUARD_REGEN = 2.5;
/** Posture regen rate by vitality, both fighters: 100-75% / 75-50% / 50-25% / 25-0%. */
export function vitalityRegen(frac: number): number {
  return frac > 0.75 ? 1 : frac > 0.5 ? 0.66 : frac > 0.25 ? 0.33 : 0.01;
}

const WALK = 2.9;
const GUARD_WALK = 1.7;
const HEAL_WALK = 1.2;
/** Sprint (hold Shift after the step): well clear of the walk, a real burst across the roof. */
const RUN = 7.6;
const GRAVITY = 15;
const JUMP_V = 4.6;
const DODGE_T = 0.42;
const IFRAMES = 0.34;
/** Kick reach: jump again this close in front of him to kick off his body / head. */
export const KICK_REACH = 2.4;

export class Player {
  readonly pos = new THREE.Vector3(0, 0, 4);
  readonly vel = new THREE.Vector3();
  yaw = Math.PI;
  vy = 0;
  health = PLAYER_MAX.health;
  posture = 0;
  postureIdle = 0;
  state: PState = "move";
  stateT = 0;
  combo = 0;
  swing: SwingDef | null = null;
  swingHit = false;
  queued = false;
  running = false;
  guarding = false;
  gourd = GOURD.charges;
  rez = REZ.charges;
  /** This dodge was stepped toward the general (a thrust meeting it is a mikiri counter). */
  mikiriArmed = false;
  /** Kicks used in the current jump. */
  kicks = 0;
  /** Abilities (keys 1-3): recharges and the curse timer. */
  readonly abil = new Abilities();
  /** The ability being cast in the `tool` / `crow` state. */
  toolKind: AbilityId | null = null;
  private toolFired = false;
  private crowStage = 0;
  private healLeft = 0;
  private sipped = false;
  private grace = 0;
  private dodgeDir = new THREE.Vector3();
  /** Direction of the last dodge relative to her facing (for the dodge sound). */
  dodgeSide: "forward" | "back" | "left" | "right" = "back";
  private clipNow = "";
  /** Events for the game to turn into sound / fx / rules. */
  readonly events: string[] = [];

  constructor(readonly ch: Fighter) {
    ch.rig.onStep = (_f, sp) => this.events.push(sp > 4.5 ? "stepRun" : "step");
  }

  reset(): void {
    this.pos.set(0, 0, 4);
    this.vel.set(0, 0, 0);
    this.yaw = Math.PI;
    this.vy = 0;
    this.health = PLAYER_MAX.health;
    this.posture = 0;
    this.postureIdle = 0;
    this.state = "move";
    this.stateT = 0;
    this.swing = null;
    this.running = false;
    this.gourd = GOURD.charges;
    this.rez = REZ.charges;
    this.healLeft = 0;
    this.grace = 0;
    this.kicks = 0;
    this.mikiriArmed = false;
    this.abil.reset();
    this.toolKind = null;
    this.events.length = 0;
    this.clipNow = "";
    this.setClip("idle", 0);
  }

  setClip(name: string, fade = 0.12, t0 = 0): void {
    this.clipNow = name;
    this.ch.play(name, fade, t0);
  }

  enter(s: PState): void {
    this.state = s;
    this.stateT = 0;
  }

  get invulnerable(): boolean {
    const s = this.state;
    return (
      (s === "dodge" && this.stateT < IFRAMES) ||
      s === "mikiri" ||
      s === "thrown" ||
      s === "revive" ||
      s === "dead" ||
      s === "deathblow" ||
      s === "finisher" ||
      s === "victory" ||
      (s === "crow" && this.stateT < ABILITY.crow.end) ||
      this.grace > 0
    );
  }

  /** Feet clear of a low sweep. */
  get airborne(): boolean {
    return this.pos.y > 0.25;
  }

  /** States in which an incoming hit can be blocked or deflected. */
  get canGuard(): boolean {
    if (this.state === "move" || this.state === "deflect" || this.state === "block") return true;
    if (this.state === "attack" && this.swing) return this.stateT > this.swing.t1 + 0.04;
    // Out of a hit reaction the guard comes back before the stagger ends (no stun-locks).
    if (this.state === "hit") return this.stateT > this.hitGuard;
    // In the air: deflect only (a held guard doesn't block while airborne).
    if (this.state === "jump" || this.state === "kick") return true;
    return false;
  }

  /** When the guard returns in the current hit reaction (sooner after his deflect). */
  private hitGuard = HIT_GUARD;

  get busy(): boolean {
    const s = this.state;
    return s === "hit" || s === "guardbreak" || s === "dead" || s === "thrown" || s === "revive" || s === "deathblow" || s === "finisher" || s === "victory";
  }

  get healing(): boolean {
    return this.state === "heal";
  }

  update(dt: number, input: Input | null, camYaw: number, target: THREE.Vector3, locked: boolean): void {
    this.stateT += dt;
    this.postureIdle += dt;
    if (this.grace > 0) this.grace -= dt;
    this.abil.tick(dt);
    const s = this.state;
    // Posture: no recovery while attacking, sprinting or staggered; faster behind a raised
    // guard; slower the lower your vitality.
    const noRegen = s === "attack" || s === "airAttack" || s === "guardbreak" || s === "thrown" || s === "dead" || s === "hit" || this.running;
    if (this.postureIdle > POSTURE_DELAY && !noRegen) {
      const k = (this.guarding ? GUARD_REGEN : 1) * vitalityRegen(this.health / PLAYER_MAX.health);
      this.posture = Math.max(0, this.posture - dt * DIFFICULTY.playerPostureRegen * k);
    }
    if (this.healLeft > 0 && s !== "dead") {
      const d = Math.min(this.healLeft, (dt * GOURD.heal * PLAYER_MAX.health) / GOURD.over);
      this.health = Math.min(PLAYER_MAX.health, this.health + d);
      this.healLeft -= d;
      if (this.health >= PLAYER_MAX.health) this.healLeft = 0;
    }
    const toT = new THREE.Vector3().subVectors(target, this.pos).setY(0);
    const dist = toT.length();
    const faceYaw = Math.atan2(toT.x, toT.z);

    // Camera-relative input.
    const ax = input ? input.axis() : { x: 0, y: 0 };
    const fx = Math.sin(camYaw);
    const fz = Math.cos(camYaw);
    const move = new THREE.Vector3(fx * ax.y - fz * ax.x, 0, fz * ax.y + fx * ax.x);
    const moving = move.lengthSq() > 0.01;
    this.guarding = !!input && input.isHeld("block") && (s === "move" || s === "block" || s === "deflect");
    const dodgeNow = () => this.startDodge(moving ? move : null, faceYaw, locked, dist, toT);

    if (s === "move") {
      if (input) {
        if (input.consume("dodge", BUFFER.dodge)) return dodgeNow();
        if (input.consume("attack", BUFFER.attack)) return this.startSwing(SWINGS[0], 0);
        if (input.consume("jump", BUFFER.jump)) return this.startJump();
        if (input.consume("heal", BUFFER.heal)) {
          if (this.gourd > 0) return this.startHeal();
          this.events.push("gourdEmpty");
        }
        if (this.tryAbility(input)) return;
        if (this.freshGuard(input)) return this.startDeflect();
      }
      if (this.running && (!input || !input.isHeld("dodge") || !moving)) this.running = false;
      const speed = this.running ? RUN : this.guarding ? GUARD_WALK : WALK;
      const tv = moving ? move.clone().normalize().multiplyScalar(speed * Math.min(1, move.length())) : new THREE.Vector3();
      this.vel.lerp(tv, damp(this.running ? 8 : 12, dt));
      if ((locked && !this.running) || (this.guarding && dist < GUARD_FACE)) this.yaw = approachAngle(this.yaw, faceYaw, dt * 12);
      else if (moving) this.yaw = approachAngle(this.yaw, Math.atan2(move.x, move.z), dt * 11);
      const want = this.running ? "run" : this.guarding ? "guard" : "idle";
      if (this.clipNow !== want) this.setClip(want, 0.18);
    } else if (s === "dodge") {
      const u = this.stateT / DODGE_T;
      const v = 9.5 * Math.pow(Math.max(0, 1 - u), 1.6);
      this.vel.copy(this.dodgeDir).multiplyScalar(v);
      if (this.stateT >= DODGE_T) {
        this.events.push("dodgeLand");
        this.running = !!input && input.isHeld("dodge");
        this.mikiriArmed = false;
        this.enter("move");
        this.setClip(this.running ? "run" : "idle", 0.15);
      } else if (this.stateT > 0.3 && input) {
        if (input.consume("attack", BUFFER.attack)) return this.startSwing(SWINGS[0], 0);
        if (this.freshGuard(input, BUFFER.block)) return this.startDeflect();
        if (this.stateT > 0.32 && input.consume("jump", BUFFER.jump)) return this.startJump();
        if (this.tryAbility(input)) return;
      }
    } else if (s === "attack" && this.swing) {
      const sw = this.swing;
      if (this.stateT - dt < sw.whoosh && this.stateT >= sw.whoosh) this.events.push(sw.heavy ? "swingHeavy" : "swing");
      if (input && this.stateT > 0.1 && input.consume("attack", 0.3)) this.queued = true;
      // Recovery cancels once the cut is over.
      if (input && this.stateT > sw.t1) {
        if (input.consume("dodge", BUFFER.dodge)) return dodgeNow();
        if (this.freshGuard(input, BUFFER.block)) return this.startDeflect();
        if (input.consume("jump", BUFFER.jump)) return this.startJump();
        if (this.tryAbility(input)) return;
      }
      // Magnetism: close the gap during the wind-up and swing.
      let lunge = 0;
      if (this.stateT < sw.t1 && locked && dist > 1.9 && dist < 6) lunge = Math.min(sw.heavy ? 4.5 : 3.8, (dist - 1.7) / 0.2);
      else if (this.stateT < sw.t1) lunge = 0.8;
      if (locked && this.stateT < sw.t0) this.yaw = approachAngle(this.yaw, faceYaw, dt * 14);
      this.vel.set(Math.sin(this.yaw) * lunge, 0, Math.cos(this.yaw) * lunge);
      // Holding attack through the first cut flows into the charged cut.
      if (this.combo === 0 && !this.queued && input && input.isHeld("attack") && input.heldFor("attack") >= this.stateT - 0.03 && this.stateT >= sw.chain)
        return this.startSwing(CHARGED, 3);
      if (this.queued && this.stateT >= sw.chain && this.combo < 2) return this.startSwing(SWINGS[this.combo + 1], this.combo + 1);
      if (this.stateT >= sw.dur) {
        this.enter("move");
        this.setClip("idle", 0.2);
      }
    } else if (s === "deflect" || s === "block") {
      this.vel.multiplyScalar(Math.exp(-dt * 10));
      if (locked || dist < GUARD_FACE) this.yaw = approachAngle(this.yaw, faceYaw, dt * 12);
      if (input && this.stateT > 0.08 && input.consume("attack", BUFFER.attack)) return this.startSwing(SWINGS[0], 0);
      if (input && this.stateT > 0.05 && input.consume("dodge", BUFFER.dodge)) return dodgeNow();
      if (input && this.stateT > 0.05 && input.consume("jump", BUFFER.jump)) return this.startJump();
      if (input && this.stateT > 0.05 && this.tryAbility(input)) return;
      // A re-press while the flick plays restarts it (a fresh window is granted by Input).
      if (input && this.stateT > 0.04 && this.freshGuard(input)) return this.startDeflect();
      if (this.stateT > (s === "deflect" ? 0.26 : 0.3)) {
        this.enter("move");
        this.setClip(this.guarding ? "guard" : "idle", 0.12);
      }
    } else if (s === "hit") {
      this.vel.multiplyScalar(Math.exp(-dt * 6));
      if (input && this.stateT > this.hitGuard && this.freshGuard(input, BUFFER.block)) return this.startDeflect();
      if (input && this.stateT > 0.3 && input.consume("dodge", BUFFER.dodge)) return dodgeNow();
      if (this.stateT > 0.4) {
        this.enter("move");
        this.setClip("idle", 0.15);
      }
    } else if (s === "guardbreak") {
      this.vel.multiplyScalar(Math.exp(-dt * 5));
      // Step dodge or jump shortens the break with a safety roll.
      if (input && this.stateT > 0.35 && (input.consume("dodge", 0.4) || input.consume("jump", 0.4))) {
        this.posture = 50;
        this.events.push("safetyRoll");
        return dodgeNow();
      }
      if (this.stateT > 1.25) {
        this.posture = 50;
        this.enter("move");
        this.setClip("idle", 0.2);
      }
    } else if (s === "jump" || s === "kick") {
      this.fall(dt);
      if (moving) this.vel.lerp(move.clone().normalize().multiplyScalar(WALK), damp(4, dt));
      if (locked) this.yaw = approachAngle(this.yaw, faceYaw, dt * 8);
      if (s === "kick" && this.stateT > 0.28) {
        this.enter("jump");
        this.setClip("jump", 0.1, 0.15);
      }
      if (input && input.consume("attack", 0.2)) return this.startSwing(AIR_CUT, 0);
      if (input && s === "jump" && input.consume("jump", 0.15) && this.kicks < 1) {
        const facing = Math.abs(Math.atan2(Math.sin(faceYaw - this.yaw), Math.cos(faceYaw - this.yaw)));
        if (dist < KICK_REACH && (facing < 1.2 || locked)) return this.startKick(faceYaw, toT);
      }
      if (this.pos.y <= 0 && this.vy < 0) this.land();
    } else if (s === "airAttack" && this.swing) {
      const sw = this.swing;
      if (this.stateT - dt < sw.whoosh && this.stateT >= sw.whoosh) this.events.push("swingHeavy");
      if (this.pos.y > 0 || this.vy > 0) {
        this.vy -= GRAVITY * 0.35 * dt;
        this.fall(dt);
        if (this.stateT < sw.t1 && dist > 1.4 && dist < 4) this.vel.lerp(toT.clone().normalize().multiplyScalar(3), damp(6, dt));
        if (this.pos.y <= 0 && this.vy < 0) {
          this.pos.y = 0;
          this.vy = 0;
          this.events.push("land");
        }
      } else this.vel.multiplyScalar(Math.exp(-dt * 10));
      if (locked && this.stateT < sw.t0) this.yaw = approachAngle(this.yaw, faceYaw, dt * 12);
      if (this.stateT >= sw.dur) {
        if (this.pos.y > 0) {
          this.enter("jump");
          this.setClip("jump", 0.1, 0.15);
        } else {
          this.enter("move");
          this.setClip("jumpLand", 0.06);
          this.clipNow = "jumpLand";
        }
      }
    } else if (s === "heal") {
      const tv = moving ? move.clone().normalize().multiplyScalar(HEAL_WALK) : new THREE.Vector3();
      this.vel.lerp(tv, damp(10, dt));
      if (locked) this.yaw = approachAngle(this.yaw, faceYaw, dt * 8);
      const tl = this.ch.timeline("heal");
      if (!this.sipped && this.stateT >= cueOf(tl, "sip", 0.45)) {
        this.sipped = true;
        this.healLeft += GOURD.heal * PLAYER_MAX.health;
        this.events.push("sip");
      }
      // Once swallowed, the rest of the motion can be cut short by a step or a jump.
      if (this.sipped && input && this.stateT > cueOf(tl, "sip", 0.45) + 0.08) {
        if (input.consume("dodge", BUFFER.dodge)) return dodgeNow();
        if (input.consume("jump", BUFFER.jump)) return this.startJump();
      }
      if (this.stateT >= tl.end) {
        this.enter("move");
        this.setClip("idle", 0.15);
      }
    } else if (s === "tool") {
      // Casting (1: the curse takes the blade, 2: the firecrackers leave her hand).
      this.vel.multiplyScalar(Math.exp(-dt * 10));
      if (locked || dist < GUARD_FACE) this.yaw = approachAngle(this.yaw, faceYaw, dt * 12);
      const curse = this.toolKind === "curse";
      const at = curse ? ABILITY.curse.ignite : ABILITY.crackers.fire;
      const end = curse ? ABILITY.curse.cast : ABILITY.crackers.cast;
      if (!this.toolFired && this.stateT >= at) {
        this.toolFired = true;
        if (curse) this.abil.curseT = ABILITY.curse.duration;
        this.events.push(curse ? "curseOn" : "crackers");
      }
      // Once it's out of her hand the tail of the motion cancels into guard, a step or a cut.
      if (this.toolFired && input && this.stateT > end * 0.6) {
        if (this.freshGuard(input, BUFFER.block)) return this.startDeflect();
        if (input.consume("dodge", BUFFER.dodge)) return dodgeNow();
        if (input.consume("attack", BUFFER.attack)) return this.startSwing(SWINGS[0], 0);
      }
      if (this.stateT >= end) {
        this.enter("move");
        this.setClip("idle", 0.15);
      }
    } else if (s === "crow") {
      // Into the feathers (the game hides her and moves her behind him), out at his back.
      this.vel.multiplyScalar(Math.exp(-dt * 12));
      const c = ABILITY.crow;
      if (this.crowStage === 0 && this.stateT >= c.vanish) {
        this.crowStage = 1;
        this.events.push("crowVanish");
      }
      if (this.crowStage === 1 && this.stateT >= c.appear) {
        this.crowStage = 2;
        this.yaw = faceYaw;
        this.events.push("crowAppear");
      }
      if (this.crowStage === 2) {
        this.yaw = approachAngle(this.yaw, faceYaw, dt * 16);
        if (input && input.consume("attack", BUFFER.attack)) return this.startSwing(SWINGS[0], 0);
      }
      if (this.stateT >= c.end) {
        this.enter("move");
        this.setClip("idle", 0.1);
      }
    } else if (s === "mikiri") {
      this.vel.multiplyScalar(Math.exp(-dt * 14));
      this.yaw = approachAngle(this.yaw, faceYaw, dt * 10);
      const tl = this.ch.timeline("mikiri");
      // Off the blade and straight into the opening.
      if (input && this.stateT > cueOf(tl, "stomp", 0.16) + 0.3) {
        if (input.consume("attack", BUFFER.attack)) return this.startSwing(SWINGS[0], 0);
        if (input.consume("dodge", BUFFER.dodge)) return dodgeNow();
        if (this.freshGuard(input, BUFFER.block)) return this.startDeflect();
      }
      if (this.stateT >= tl.end) {
        this.enter("move");
        this.setClip("idle", 0.15);
      }
    } else if (s === "revive") {
      this.vel.set(0, 0, 0);
      const tl = this.ch.timeline("revive");
      if (this.stateT >= tl.end) {
        this.grace = REVIVE_GRACE;
        this.enter("move");
        this.setClip("idle", 0.2);
      }
    } else if (s === "thrown") {
      // Positioned by the game while held; free once he lets go.
      if (this.stateT >= this.ch.timeline("thrown").end) {
        this.enter("move");
        this.setClip("idle", 0.2);
      }
    } else {
      this.vel.multiplyScalar(Math.exp(-dt * 8));
    }
    // Knocked out of a jump (hit, guard break): nothing holds him up.
    const st = this.state;
    if ((this.pos.y > 0 || this.vy > 0) && st !== "jump" && st !== "kick" && st !== "airAttack" && st !== "thrown") {
      this.fall(dt);
      if (this.pos.y <= 0) {
        this.vy = 0;
        this.kicks = 0;
      }
    }

    this.pos.addScaledVector(this.vel, dt);
    this.confine();
  }

  /** A buffered ability key: cast it if it's charged (and, for the curse, not already burning). */
  private tryAbility(input: Input): boolean {
    for (const [a, id] of ABILITY_KEYS) {
      if (!input.consume(a, BUFFER.ability)) continue;
      if (!this.abil.ready(id) || (id === "curse" && this.abil.cursed)) {
        this.events.push(`denied:${id}`);
        continue;
      }
      this.abil.spend(id);
      this.startTool(id);
      return true;
    }
    return false;
  }

  private startTool(id: AbilityId): void {
    this.running = false;
    this.toolKind = id;
    this.toolFired = false;
    this.crowStage = 0;
    this.swing = null;
    if (id === "crow") {
      this.enter("crow");
      this.setClip("crow", 0.05);
      this.events.push("crowDive");
    } else {
      this.enter("tool");
      this.setClip(id === "curse" ? "curse" : "tool", 0.06);
      this.events.push(id === "curse" ? "curseCast" : "crackersCast");
    }
  }

  /** A guard press this step (or buffered `buffer` s): the flick into a deflect. */
  private freshGuard(input: Input, buffer = 0.02): boolean {
    const bp = input.peekPressTime("block");
    if (bp === undefined || input.clock - bp >= buffer || bp === this.flickPress) return false;
    this.flickPress = bp;
    return true;
  }

  /** Stamp of the guard press that started the current flick (each press flicks once). */
  private flickPress = -1;

  private startDeflect(): void {
    this.enter("deflect");
    this.setClip("deflect", 0.05);
  }

  private fall(dt: number): void {
    this.vy -= GRAVITY * dt;
    this.pos.y += this.vy * dt;
    if (this.pos.y < 0) this.pos.y = 0;
  }

  private land(): void {
    this.pos.y = 0;
    this.vy = 0;
    this.kicks = 0;
    this.enter("move");
    this.setClip("idle", 0.12);
    this.events.push("land");
  }

  confine(): void {
    this.pos.x = clamp(this.pos.x, -ARENA_HALF, ARENA_HALF);
    this.pos.z = clamp(this.pos.z, RIDGE_Z + 1.3, ARENA_HALF);
  }

  private startJump(): void {
    this.vy = JUMP_V;
    this.kicks = 0;
    this.running = false;
    this.enter("jump");
    this.setClip("jump", 0.1);
    this.events.push("jump");
  }

  private startKick(faceYaw: number, toT: THREE.Vector3): void {
    this.kicks++;
    this.yaw = faceYaw;
    this.vy = 5.0;
    this.vel.copy(toT).setY(0).normalize().multiplyScalar(-2.2);
    this.enter("kick");
    this.setClip("kick", 0.04);
    this.events.push("kick");
  }

  private startHeal(): void {
    this.gourd--;
    this.sipped = false;
    this.running = false;
    this.enter("heal");
    this.setClip("heal", 0.1);
    this.events.push("drink");
  }

  private startDodge(move: THREE.Vector3 | null, faceYaw: number, locked: boolean, dist: number, toT: THREE.Vector3): void {
    if (move) this.dodgeDir.copy(move).normalize();
    else if (locked) this.dodgeDir.set(-Math.sin(faceYaw), 0, -Math.cos(faceYaw));
    else this.dodgeDir.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    // Mikiri: a step toward him (or a neutral step while locked on) within reach of a thrust.
    const toward = dist > 1e-3 ? this.dodgeDir.dot(_t.copy(toT).normalize()) : 0;
    this.mikiriArmed = dist < 6 && (toward > 0.7 || (!move && locked));
    if (!locked) this.yaw = Math.atan2(this.dodgeDir.x, this.dodgeDir.z);
    else if (toward > 0.7) this.yaw = faceYaw;
    this.running = false;
    this.enter("dodge");
    {
      const cy = Math.cos(this.yaw);
      const sy = Math.sin(this.yaw);
      const f = this.dodgeDir.x * sy + this.dodgeDir.z * cy;
      const sd = this.dodgeDir.x * cy - this.dodgeDir.z * sy;
      this.dodgeSide = Math.abs(sd) > Math.abs(f) ? (sd > 0 ? "left" : "right") : f > 0 ? "forward" : "back";
    }
    // Skinned bodies pick a directional dodge clip from the body velocity at the start.
    this.ch.rig.vel.copy(this.dodgeDir);
    this.ch.rig.yaw = this.yaw;
    this.setClip("dodge", 0.06);
    this.events.push("dodge");
  }

  private startSwing(spec: SwingSpec, i: number): void {
    this.combo = i;
    const tl = this.ch.timeline(spec.clip);
    const h = tl.hits[0] ?? { start: 0, end: 0 };
    this.swing = { ...spec, t0: h.start, t1: h.end, dur: tl.end, chain: tl.chain, whoosh: tl.whoosh[0] ?? h.start };
    this.swingHit = false;
    this.queued = false;
    this.running = false;
    this.enter(spec === AIR_CUT ? "airAttack" : "attack");
    this.setClip(spec.clip, i === 0 ? 0.08 : 0.05);
  }

  /** A swing that hasn't landed is winding up or live: its blade must not be steered. */
  get strikeSoon(): boolean {
    return (this.state === "attack" || this.state === "airAttack") && !!this.swing && !this.swingHit && this.stateT <= this.swing.t1;
  }

  /** Is the current swing's hit window open? */
  get swingActive(): boolean {
    return (this.state === "attack" || this.state === "airAttack") && !!this.swing && !this.swingHit && this.stateT >= this.swing.t0 && this.stateT <= this.swing.t1;
  }

  takeHit(from: THREE.Vector3): void {
    this.healLeft = this.sipped ? this.healLeft : 0;
    this.mikiriArmed = false;
    this.hitGuard = HIT_GUARD;
    this.enter("hit");
    this.setClip("hit", 0.08);
    const away = new THREE.Vector3().subVectors(this.pos, from).setY(0).normalize();
    this.vel.copy(away).multiplyScalar(4);
  }

  /**
   * His guard turned the blade aside: a longer recoil than a hit (no posture damage), but the
   * guard is back almost at once so his answering string can be deflected.
   */
  deflected(): void {
    this.hitGuard = -0.04;
    this.enter("hit");
    this.stateT = -0.12;
    this.setClip("hit", 0.05);
  }

  guardBreak(): void {
    this.enter("guardbreak");
    this.setClip("guardbreak", 0.06);
  }

  mikiri(): void {
    this.mikiriArmed = false;
    this.vel.set(0, 0, 0);
    this.enter("mikiri");
    this.setClip("mikiri", 0.04);
  }

  thrownBy(): void {
    this.healLeft = 0;
    this.vy = 0;
    this.enter("thrown");
    this.setClip("thrown", 0.06);
  }

  die(): void {
    this.healLeft = 0;
    this.vy = 0;
    this.pos.y = 0;
    this.enter("dead");
    this.setClip("death", 0.1);
  }

  /** Resurrection: get up on the spot with part of the vitality back. */
  revive(): void {
    this.rez--;
    this.health = PLAYER_MAX.health * REZ.health;
    this.posture = 0;
    this.postureIdle = 0;
    this.vel.set(0, 0, 0);
    this.enter("revive");
    this.setClip("revive", 0.15);
  }

  step(dt: number, wind: THREE.Vector3, t: number): void {
    this.ch.rig.root.position.copy(this.pos);
    this.ch.rig.yaw = this.yaw;
    this.ch.rig.vel.copy(this.vel);
    this.ch.step(dt, wind, t);
    this.ch.trail.emitting = (this.state === "attack" || this.state === "airAttack") && !!this.swing && this.stateT > this.swing.t0 - 0.05 && this.stateT < this.swing.t1 + 0.04;
  }
}

const _t = new THREE.Vector3();
