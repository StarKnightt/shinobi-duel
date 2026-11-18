/**
 * What gameplay (Player / Boss / Game) needs from a fighter's body, whichever kind drives it:
 * the procedural pose rig (default, always available) or a SkinnedCharacter loaded from
 * Mixamo assets. FighterSlot swaps between them without the gameplay code noticing.
 */
import type * as THREE from "three";
import type { Trail } from "../fx/Trail";
import type { Timeline } from "./animEvents";

/** World-space anchors and the collision shape, refreshed every step. */
export interface FighterRig {
  readonly root: THREE.Object3D;
  readonly hiltW: THREE.Vector3;
  readonly tipW: THREE.Vector3;
  readonly prevHiltW: THREE.Vector3;
  readonly prevTipW: THREE.Vector3;
  readonly chestW: THREE.Vector3;
  readonly headW: THREE.Vector3;
  readonly hipsW: THREE.Vector3;
  readonly vel: THREE.Vector3;
  yaw: number;
  onStep: ((foot: number, speed: number) => void) | null;
  /** Collision capsule (world): writes the segment, returns the radius. */
  capsule(a: THREE.Vector3, b: THREE.Vector3): number;
  resetTrail(): void;
}

export interface Fighter {
  readonly kind: "procedural" | "skinned";
  readonly rig: FighterRig;
  readonly trail: Trail;
  readonly clipName: string;
  /** Events for a logical clip / attack, resolved to seconds of attack time. */
  timeline(name: string): Timeline;
  play(name: string, fade?: number, t0?: number): void;
  /**
   * Freeze animation playback (gameplay time keeps running). On release the animation skips
   * ahead by the held time so it stays in sync with the gameplay clock.
   */
  setHold(on: boolean): void;
  /** Re-pose at fraction `s` (0..1) between the previous and current step: the exact contact. */
  snapBack(s: number): void;
  /** Block / deflect: bring the blade through `target` (world). `null` releases. */
  guardAt(target: THREE.Vector3 | null): void;
  /**
   * The weapon was stopped by a guard: rebound instead of following through. `hold` keeps the
   * rebound up for that much longer (a blocked final blow skips its follow-through).
   */
  bounce(hold?: number): void;
  /** Outside its active windows the blade would pass through the other fighter: lift it clear. */
  setAvoid(on: boolean): void;
  /** Deathblows (skinned bodies): drive the blade into this live point during the plunge; null clears. */
  plungeInto?(target: THREE.Vector3 | null): void;
  step(dt: number, wind: THREE.Vector3, t: number): void;
  frame(dt: number): void;
  beginRender(d: THREE.Vector3): void;
  endRender(): void;
  resetCloth(): void;
  addTo(scene: THREE.Scene): void;
  setVisible(on: boolean): void;
  /** Debug (?debug=anim): the body's clips, and posing one at a clip time. */
  listClips(): { name: string; dur: number; loop: boolean }[];
  scrub(clip: string, t: number): void;
  /** Body glow (skinned bodies): colour × k on the rim, `body` spreads it inward. null clears. */
  setGlow?(color: THREE.Color | null, k?: number, body?: number): void;
}
