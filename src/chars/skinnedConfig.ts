/**
 * Everything a Mixamo body needs, per character: where the files are, how logical clips map to
 * asset clips (loop / once, speed or a gameplay length to fit), per-transition crossfade times,
 * which bones carry the capsule, sword and reused procedural parts, and where the cloth pins.
 *
 * Offsets are metres in the bone's frame after the model is scaled to `height`; rotations are
 * XYZ Euler radians. Tuned for Kachujin G Rosales (player) and Paladin J Nordstrom (boss); check
 * other characters in `?debug=anim` / tools/charshot.mjs. `fit` / `speed` only matter for moves the
 * procedural rig has no timeline for (the rest are time-warped onto the gameplay clock).
 */
import { MIXAMO_BOSS, MIXAMO_BOSS_PLANS, MIXAMO_PLAYER, type EventTable, type Segment } from "./animEvents";

export type V3 = [number, number, number];

export interface ClipSpec {
  /** Asset clip name (file basename / Blender action name, lower case). */
  clip: string;
  loop?: boolean;
  speed?: number;
  /** Play the whole clip in this many seconds (the gameplay state's length). */
  fit?: number;
  /** Start at the clip's last frame and hold it (lying still after a finisher). */
  atEnd?: boolean;
  /** Asset clips to use (in order) when `clip` isn't in the files; its events come along. */
  alt?: string[];
  /** Largest speed-up of the clip's lead-in / recovery when fitted to the gameplay clock (default 1.6). */
  warpK?: number;
  /** Extra clips taken in turn with `clip` (the ones present), e.g. varied hit reactions. */
  variants?: string[];
  /** Pick the clip by the body's local velocity when the move starts (directional dodges). */
  dir?: { fwd: string; back: string; left: string; right: string };
}

export interface Socket {
  bone: string;
  offset: V3;
  rot: V3;
  /** Uniform scale of what hangs in the socket (procedural parts are authored ×1 or ×1.2). */
  scale: number;
}

/** A bone rotation added on top of the mixer: rebound and blade-avoid reactions. */
export interface BoneKick {
  bone: string;
  axis: V3;
  angle: number;
}

export interface SkinnedConfig {
  name: "player" | "boss";
  /** Converted asset, served from public/. */
  glb: string;
  /** Mixamo FBX folder (dev server only; used when no GLB exists yet). */
  fbxDir: string;
  /** FBX with the skinned mesh ("With Skin"); every other FBX contributes its animation. */
  modelFile: string;
  /** Model is scaled so its bind-pose height matches (m). */
  height: number;
  /** Extra yaw if the model doesn't face +Z. */
  yawOffset: number;
  capsuleR: number;
  bones: { hips: string; chest: string; head: string; leftLeg: string; rightLeg: string };
  sword: Socket & {
    tsuba: number;
    blade: number;
    /**
     * Fit the socket from the hand itself instead of `offset` / `rot` (at `t`, normalized, of `clip`):
     * the grip axis runs through the fist from the pinky knuckle to the index knuckle, the edge
     * faces the knuckles (wrist → middle knuckle), the grip sits `palm` of the way from the wrist
     * to the knuckles, shifted `lift` m up the blade and `side` m toward the edge; then `roll`
     * radians about the blade and `tilt` toward the edge. Bone names: first one present wins (Mixamo, then UAL).
     */
    auto?: { clip: string; t: number; palm: number; lift: number; side: number; roll: number; tilt?: number };
  };
  clips: Record<string, ClipSpec>;
  /** Clips that must exist, or the body is rejected and the procedural rig stays. */
  required: string[];
  /** Idle / walk logical clips pick a locomotion clip from the body's local velocity. */
  locomotion: { idle: string; walk: string; back?: string; left?: string; right?: string; run?: string; turnLeft?: string; turnRight?: string; walkSpeed: number; runSpeed: number };
  /** Crossfade seconds per transition: "from>to", "*>to", "from>*" (logical names). */
  fades: Record<string, number>;
  events: EventTable;
  plans?: Record<string, Segment[]>;
  kicks: BoneKick[];
  /** Bones collapsed to nothing (their skin with them): the model's own head under a reused helmet. */
  hide?: string[];
  /** Meshes hidden outright (exact names), e.g. a helmet the reused kabuto replaces. */
  hideMeshes?: string[];
  /** Reused procedural parts: `part` names a group the procedural body exposes. */
  attach: (Socket & { part: string })[];
  /** Reused procedural cloth (index into the procedural body's cloths), pinned to a bone. */
  cloth: { index: number; socket: Socket }[];
  trail: { color: number; intensity: number };
  /** Healing gourd held in a hand while these logical states play. */
  gourd?: Socket & { during: string[] };
  /** Tint for the reused cloth + attached parts' materials (cloned), e.g. the kunoichi's scarf. */
  clothTint?: number;
  /** Grazing-angle rim light on the model's own materials (reads against the low sun). */
  rim?: { color: number; strength: number };
}

const SPINE_KICK: BoneKick[] = [
  // Bodies without a procedural reference only (with one, rebound / avoidance are IK layers).
  { bone: "Spine2", axis: [1, 0, 0], angle: -0.22 },
  { bone: "RightArm", axis: [0, 0, 1], angle: 0.55 },
  { bone: "RightForeArm", axis: [0, 0, 1], angle: 0.35 },
];

export const PLAYER_SKIN: SkinnedConfig = {
  name: "player",
  glb: "assets/chars/player.glb",
  fbxDir: "/assets/mixamo/player/",
  modelFile: "character",
  // The kunoichi (Mixamo "Kachujin G Rosales").
  height: 1.68,
  yawOffset: 0,
  capsuleR: 0.31,
  bones: { hips: "Hips", chest: "Spine2", head: "Head", leftLeg: "LeftLeg", rightLeg: "RightLeg" },
  // offset / rot: fallback when the hand has no finger bones for `auto`.
  sword: {
    bone: "RightHand",
    offset: [0, 0.08, 0.02],
    rot: [Math.PI / 2, 0, 0],
    scale: 1,
    tsuba: 0.075,
    blade: 0.95,
    auto: { clip: "idle", t: 0, palm: 0.8, lift: 0, side: -0.01, roll: 0 },
  },
  clips: {
    idle: { clip: "idle", loop: true },
    run: { clip: "run", loop: true },
    guard: { clip: "block", loop: true },
    deflect: { clip: "block_impact", fit: 0.3 },
    block: { clip: "block_impact", fit: 0.32 },
    dodge: { clip: "dodge", fit: 0.42, dir: { fwd: "dodge_forward", back: "dodge", left: "dodge_left", right: "dodge_right" } },
    attack1: { clip: "attack1" },
    attack2: { clip: "attack2" },
    attack3: { clip: "attack3" },
    hit: { clip: "hit", fit: 0.45, variants: ["hit_left", "hit_right"] },
    guardbreak: { clip: "stagger", fit: 1.3 },
    death: { clip: "death" },
    jump: { clip: "jump" },
    finisher: { clip: "finisher" },
    victory: { clip: "victory", loop: true, alt: ["idle"] },
    // Optional: until the files exist these borrow a close clip (and its events).
    attackC: { clip: "attack_charged", alt: ["attack3"] },
    jumpAtk: { clip: "jump_attack", alt: ["attack3"] },
    kick: { clip: "kick", fit: 0.3, alt: ["jump"] },
    heal: { clip: "drink", fit: 1.0, alt: ["idle"] },
    mikiri: { clip: "mikiri", fit: 1.05, alt: ["dodge_forward", "dodge"] },
    revive: { clip: "get_up", fit: 1.7, alt: ["idle"], warpK: 4 },
    thrown: { clip: "thrown", fit: 1.9, alt: ["knockdown", "death"] },
    deathblow: { clip: "deathblow", fit: 1.45, alt: ["finisher"] },
    // Abilities (keys 1-3): firecrackers flung from the hand, the blade raised as the curse takes it,
    // the crow step's dive into the feathers.
    tool: { clip: "block_impact", fit: 0.45, alt: ["hit"] },
    curse: { clip: "block_impact", fit: 0.6, alt: ["idle"] },
    crow: { clip: "dodge_forward", fit: 0.3, alt: ["dodge"] },
  },
  required: ["idle", "attack1", "attack2", "attack3", "block", "block_impact", "hit", "dodge", "death", "finisher"],
  locomotion: { idle: "idle", walk: "walk", back: "walk_back", left: "strafe_left", right: "strafe_right", run: "run", turnLeft: "turn_left", turnRight: "turn_right", walkSpeed: 1.6, runSpeed: 5.5 },
  fades: {
    "*>deflect": 0.04,
    "*>block": 0.04,
    "deflect>*": 0.12,
    "block>*": 0.12,
    "*>attack1": 0.08,
    "*>attack2": 0.06,
    "*>attack3": 0.06,
    "*>hit": 0.08,
    "*>dodge": 0.06,
    "hit>*": 0.15,
    "*>finisher": 0.12,
    "*>death": 0.1,
  },
  events: MIXAMO_PLAYER,
  kicks: SPINE_KICK,
  // Scarf coils round her throat; the tails hang from the back of the neck. The procedural parts are
  // authored in chest space with the throat 0.45 m up: the socket shifts them onto the Neck bone.
  attach: [{ part: "scarfWrap", bone: "Neck", offset: [0, -0.43, 0.01], rot: [0, 0, 0], scale: 0.92 }],
  cloth: [
    { index: 0, socket: { bone: "Neck", offset: [0, -0.43, 0.02], rot: [0, 0, 0], scale: 0.92 } },
    { index: 1, socket: { bone: "Neck", offset: [0, -0.43, 0.02], rot: [0, 0, 0], scale: 0.92 } },
  ],
  trail: { color: 0xbfd6ff, intensity: 1.1 },
  clothTint: 0x7a1c16,
  gourd: { bone: "LeftHand", offset: [0.0, 0.07, 0.035], rot: [0, 0, 0], scale: 1, during: ["heal"] },
  // Cold moon-silver edge (ART_DIRECTION.md: the rim is cold; warmth only comes from lanterns and sparks).
  rim: { color: 0xb4c8ff, strength: 0.2 },
};

export const BOSS_SKIN: SkinnedConfig = {
  name: "boss",
  glb: "assets/chars/boss.glb",
  fbxDir: "/assets/mixamo/boss/",
  modelFile: "character",
  height: 2.1,
  yawOffset: 0,
  capsuleR: 0.41,
  bones: { hips: "Hips", chest: "Spine2", head: "Head", leftLeg: "LeftLeg", rightLeg: "RightLeg" },
  sword: {
    bone: "RightHand",
    offset: [0, 0.09, 0.02],
    rot: [Math.PI / 2, 0, 0],
    scale: 1.2,
    tsuba: 0.075,
    blade: 1.06,
    auto: { clip: "idle", t: 0, palm: 0.8, lift: 0, side: -0.01, roll: 0, tilt: 0.26 },
  },
  clips: {
    idle: { clip: "idle", loop: true },
    walk: { clip: "walk", loop: true },
    guard: { clip: "block", loop: true },
    block: { clip: "block_impact", fit: 0.35 },
    // Deflected: his blade knocked aside (Great Sword Blocked Impact).
    recoil: { clip: "block_impact", fit: 0.95, alt: ["hit"] },
    flinch: { clip: "hit", fit: 0.4, variants: ["hit_left", "hit_right"] },
    // Posture broken: he drops to one knee (Kneeling Down) and holds it for the deathblow.
    stagger: { clip: "finished", alt: ["stagger"], warpK: 2.6 },
    staggerEnd: { clip: "kneel_idle", loop: true, alt: ["idle"] },
    // After the finisher: kneeling, then he falls forward (plan in animEvents.ts).
    finished: { clip: "death_forward", alt: ["death", "finished"] },
    dead: { clip: "death_forward", atEnd: true, alt: ["death", "finished"] },
    victory: { clip: "idle", loop: true },
    sweep: { clip: "sweep", alt: ["attack1"] },
    grab: { clip: "grab", alt: ["thrust"] },
    grabThrow: { clip: "grab_throw", fit: 1.9, alt: ["hit"] },
    mikiried: { clip: "stumble", fit: 1.6, alt: ["hit_heavy", "hit"] },
    kicked: { clip: "hit_heavy", fit: 1.0, alt: ["hit"] },
    whiff: { clip: "idle", loop: true },
    // First deathblow: down on one knee; the second life starts with a battle cry.
    rise: { clip: "battlecry", fit: 1.6, alt: ["power_up", "get_up", "idle"], warpK: 3 },
    deathblown: { clip: "finished", fit: 1.5, alt: ["stagger"] },
  },
  required: ["idle", "walk", "attack1", "combo2", "combo3", "overhead", "thrust", "leap", "block", "block_impact", "hit", "stagger", "finished"],
  locomotion: { idle: "idle", walk: "walk", back: "walk_back", left: "strafe_left", right: "strafe_right", turnLeft: "turn_left", turnRight: "turn_right", walkSpeed: 1.7, runSpeed: 99 },
  fades: {
    "*>block": 0.05,
    "*>recoil": 0.1,
    "*>flinch": 0.05,
    "*>stagger": 0.1,
    "*>finished": 0.05,
    "*>combo": 0.12,
    "*>comboDelay": 0.12,
    "*>overhead": 0.12,
    "*>thrust": 0.12,
    "*>leap": 0.12,
  },
  events: MIXAMO_BOSS,
  plans: MIXAMO_BOSS_PLANS,
  kicks: SPINE_KICK,
  // The Paladin's own helmet would poke through the close-fitting kabuto. (The export's names are
  // swapped: "Paladin_J_Nordstrom" is the 932-vertex helmet, "..._Helmet" the 8.6k-vertex body.)
  hideMeshes: ["Paladin_J_Nordstrom"],
  // The horned kabuto + menpō (the procedural head group) in place of the Paladin's helmet, and the sode.
  attach: [
    { part: "head", bone: "Head", offset: [0, -0.05, 0.0], rot: [0, 0, 0], scale: 1.12 },
    { part: "sodeR", bone: "RightShoulder", offset: [-0.08, -0.02, 0], rot: [0, 0, 0], scale: 1.08 },
    { part: "sodeL", bone: "LeftShoulder", offset: [0.08, -0.02, 0], rot: [0, 0, 0], scale: 1.08 },
  ],
  // Tattered cape pinned across the upper back.
  cloth: [{ index: 0, socket: { bone: "Spine2", offset: [0, -0.12, 0], rot: [0, 0, 0], scale: 1.2 } }],
  trail: { color: 0xff6a3a, intensity: 1.0 },
  rim: { color: 0x9fb4e6, strength: 0.17 },
};

export const SKINS = { player: PLAYER_SKIN, boss: BOSS_SKIN };

/**
 * Which bodies to use. "auto": skinned when its files exist and load cleanly, else procedural.
 * Override per page load with ?chars=procedural | skinned.
 */
export const CHAR_MODE: "auto" | "procedural" = "auto";
