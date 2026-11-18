/**
 * Adapter between gameplay and a body. Starts on the procedural rig; `swap` moves the fighter
 * onto another body (a loaded SkinnedCharacter) at runtime, carrying position, facing, the
 * step callback and the current clip across, and hides the old one. `swap(procedural)` goes back.
 */
import type * as THREE from "three";
import type { Timeline } from "./animEvents";
import type { Fighter } from "./Fighter";

export class FighterSlot implements Fighter {
  active: Fighter;
  private scene: THREE.Scene | null = null;
  private last: [string, number, number] = ["idle", 0, 0];


  constructor(readonly procedural: Fighter) {
    this.active = procedural;
  }

  get kind() {
    return this.active.kind;
  }
  get rig() {
    return this.active.rig;
  }
  get trail() {
    return this.active.trail;
  }
  get clipName() {
    return this.active.clipName;
  }

  swap(next: Fighter): void {
    if (next === this.active) return;
    const a = this.active.rig;
    const b = next.rig;
    b.root.position.copy(a.root.position);
    b.yaw = a.yaw;
    b.vel.copy(a.vel);
    b.onStep = a.onStep;
    if (this.scene && !next.rig.root.parent) next.addTo(this.scene);
    this.active.setVisible(false);
    next.setVisible(true);
    this.active = next;
    (next as Fighter & { ref?: Fighter | null }).ref = next === this.procedural ? null : this.procedural;
    next.play(this.last[0], 0, this.last[1] + this.last[2]);
    next.resetCloth();
  }

  timeline(name: string): Timeline {
    return this.active.timeline(name);
  }
  /**
   * While a skinned body is active the (hidden) procedural rig keeps running the same moves on the
   * same spot: its blade is the reference a skinned attack is steered onto inside hit windows, so
   * reach and contact stay exactly as tuned.
   */
  private get shadow(): Fighter | null {
    return this.active === this.procedural ? null : this.procedural;
  }
  private sync(): void {
    const s = this.shadow;
    if (!s) return;
    const a = this.active.rig;
    s.rig.root.position.copy(a.root.position);
    s.rig.yaw = a.yaw;
    s.rig.vel.copy(a.vel);
  }

  play(name: string, fade?: number, t0 = 0): void {
    this.last = [name, t0, 0];
    this.shadow?.play(name, fade, t0);
    this.active.play(name, fade, t0);
  }
  setHold(on: boolean): void {
    this.shadow?.setHold(on);
    this.active.setHold(on);
  }
  snapBack(s: number): void {
    this.sync();
    this.shadow?.snapBack(s);
    this.active.snapBack(s);
  }
  guardAt(target: THREE.Vector3 | null): void {
    this.active.guardAt(target);
  }
  /** Deathblows: the skinned blade is driven into this (live) point in the plunge; null clears. */
  plungeInto(target: THREE.Vector3 | null): void {
    (this.active as Fighter & { plungeInto?: (t: THREE.Vector3 | null) => void }).plungeInto?.(target);
  }
  bounce(hold?: number): void {
    this.shadow?.bounce(hold);
    this.active.bounce(hold);
  }
  setAvoid(on: boolean): void {
    // Not forwarded to the shadow: the decision comes from the skinned blade's position, and the
    // reference must keep the tuned reach.
    this.active.setAvoid(on);
  }
  step(dt: number, wind: THREE.Vector3, t: number): void {
    this.last[2] += dt;
    this.sync();
    this.shadow?.step(dt, wind, t);
    this.active.step(dt, wind, t);
  }
  frame(dt: number): void {
    this.active.frame(dt);
  }
  setGlow(color: THREE.Color | null, k = 0, body = 0): void {
    this.active.setGlow?.(color, k, body);
  }
  beginRender(d: THREE.Vector3): void {
    this.active.beginRender(d);
  }
  endRender(): void {
    this.active.endRender();
  }
  resetCloth(): void {
    this.active.resetCloth();
  }
  addTo(scene: THREE.Scene): void {
    this.scene = scene;
    this.active.addTo(scene);
  }
  setVisible(on: boolean): void {
    this.active.setVisible(on);
  }
  listClips() {
    return this.active.listClips();
  }
  scrub(clip: string, t: number): void {
    this.active.scrub(clip, t);
  }
}
