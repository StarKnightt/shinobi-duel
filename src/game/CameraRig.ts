/**
 * Third-person camera. Lock-on (default) sits behind the player on the boss→player line with a
 * right-shoulder offset and frames both fighters; free mode orbits with the mouse. Title mode
 * drifts around the arena; the finisher gets a low side angle that pushes in. Shake is
 * trauma-based (offset ∝ trauma²) and always runs on real time so hitstop can't freeze it.
 */
import * as THREE from "three";
import { clamp, damp, lerp, smooth } from "../core/math";
import { ARENA_HALF, RIDGE_Z } from "../world/Arena";

export type CamMode = "title" | "intro" | "lock" | "free" | "finisher" | "death" | "victory";

/** Where the keep stands on the horizon (the title shot looks at it). */
const KEEP_X = -3.5;
const KEEP_Z = -14;
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();

export class CameraRig {
  mode: CamMode = "title";
  readonly pos = new THREE.Vector3(8, 3, 10);
  readonly look = new THREE.Vector3(0, 1.4, 0);
  yaw = Math.PI;
  pitch = 0.18;
  trauma = 0;
  fovPunch = 0;
  private t = 0;
  private modeT = 0;
  private readonly from = new THREE.Vector3();
  private readonly fromLook = new THREE.Vector3();
  private readonly finSide = new THREE.Vector3();
  /** Title → fight: hard cut to a low wide angle on the boss's leap, then dolly to the shoulder. */
  private introCut = false;
  /** Lock-on toggled: follow rates ease in so the re-frame doesn't whip. */
  private swap = false;
  baseFov = 52;
  /** Crow step: hold the shot on the feathers while she is gone, then a wide two-shot. */
  private holdT = 0;
  private wideT = 0;
  private wideCut = false;
  /** Test harness: fixed camera. */
  override: { pos: THREE.Vector3; look: THREE.Vector3 } | null = null;

  constructor(readonly cam: THREE.PerspectiveCamera) {}

  setMode(m: CamMode): void {
    if (m === this.mode) return;
    this.introCut = m === "intro" && this.mode === "title";
    this.swap = (m === "lock" || m === "free") && (this.mode === "lock" || this.mode === "free");
    this.from.copy(this.pos);
    this.fromLook.copy(this.look);
    this.mode = m;
    this.modeT = 0;
  }

  shake(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  /** She vanished: keep the frame on the burst instead of swinging round him. */
  hold(t: number): void {
    this.holdT = t;
  }

  /** She came out behind him: cut to a wider two-shot from her new side, then ease back in. */
  cutWide(): void {
    this.holdT = 0;
    this.wideT = 1.6;
    this.wideCut = true;
  }

  punch(amount: number): void {
    this.fovPunch = Math.max(this.fovPunch, amount);
  }

  /** Horizontal forward (for camera-relative movement). */
  get moveYaw(): number {
    return Math.atan2(this.look.x - this.pos.x, this.look.z - this.pos.z);
  }

  update(
    dt: number,
    player: THREE.Vector3,
    playerChest: THREE.Vector3,
    boss: THREE.Vector3,
    bossChest: THREE.Vector3,
    mouse: { dx: number; dy: number },
  ): void {
    this.t += dt;
    this.modeT += dt;
    const P = new THREE.Vector3();
    const L = new THREE.Vector3();
    let rate = 7;
    let lookRate = 9;

    if (this.mode === "title") {
      // Slow drift low behind the shinobi's shoulder toward the general, the keep and the sun.
      const a = Math.sin(this.t * 0.05) * 0.35 + 0.35;
      P.set(4.2 + Math.sin(a) * 3, 1.5 + Math.sin(this.t * 0.2) * 0.12, 9.5 - a * 1.5);
      L.set(-3.5, 2.6, -14);
      // Intro: the shot opens wide and high over the roof and settles into the drift (~6 s).
      const u = clamp(this.modeT / 6, 0, 1);
      const e = 1 - (1 - u) * (1 - u) * (1 - u);
      P.x += (1 - e) * 2.2;
      P.y += (1 - e) * 2.4;
      P.z += (1 - e) * 4.5;
      L.y += (1 - e) * 1.6;
      rate = 3;
      lookRate = 3;
    } else if (this.mode === "lock" || this.mode === "intro") {
      const back = _v.subVectors(player, boss).setY(0);
      const d = back.length();
      if (d < 0.01) back.set(0, 0, 1);
      back.normalize();
      const right = _w.set(-back.z, 0, back.x);
      // Offset over the right shoulder and raised so the general stays visible beside and
      // above the shinobi instead of hiding behind him.
      const dist = 3.3 + clamp(d - 3, 0, 6) * 0.2;
      P.copy(player).addScaledVector(back, dist).addScaledVector(right, -1.35);
      P.y = player.y * 0.6 + 2.2 + clamp(3 - d, 0, 3) * 0.12;
      L.copy(playerChest).lerp(bossChest, 0.6);
      L.y = lerp(playerChest.y, bossChest.y, 0.5) - 0.2;
      this.yaw = Math.atan2(-back.x, -back.z);
      // Crow step: a side-on two-shot (both in profile, never overlapping), always from the
      // keep-facing side of the roof, then it eases back to the shoulder.
      const wide = smooth(clamp(this.wideT / 0.9, 0, 1));
      if (wide > 0) {
        const mx = (player.x + boss.x) / 2;
        const mz = (player.z + boss.z) / 2;
        // The side of the pair that looks toward the keep (the art-directed view), turned a
        // little further toward it: a three-quarter shot with the keep behind them.
        let kx = KEEP_X - mx;
        let kz = KEEP_Z - mz;
        const kl = Math.hypot(kx, kz) || 1;
        kx /= kl;
        kz /= kl;
        const side = _w.set(back.z, 0, -back.x);
        if (side.x * kx + side.z * kz > 0) side.negate();
        side.x -= kx * 0.55;
        side.z -= kz * 0.55;
        side.normalize();
        _v.set(mx + side.x * 4.6, 2.0, mz + side.z * 4.6);
        P.lerp(_v, wide);
        _v.set(mx, lerp(playerChest.y, bossChest.y, 0.5) - 0.15, mz);
        L.lerp(_v, wide);
      }
      if (this.mode === "intro") {
        if (this.introCut) {
          this.introCut = false;
          this.from.copy(player).addScaledVector(right, -3.6).addScaledVector(back, 1.2).setY(0.55);
          this.fromLook.copy(bossChest).setY(bossChest.y + 1.4);
          this.pos.copy(this.from);
          this.look.copy(this.fromLook);
        }
        const u = smooth(clamp(this.modeT / 1.2, 0, 1));
        P.lerpVectors(this.from, P, u);
        L.lerpVectors(this.fromLook, L, u);
        rate = 30;
        lookRate = 30;
        if (this.modeT > 1.2) this.mode = "lock";
      }
    } else if (this.mode === "free") {
      this.yaw -= mouse.dx * 0.0026;
      this.pitch = clamp(this.pitch + mouse.dy * 0.002, -0.35, 0.8);
      const r = 4.0;
      P.set(
        player.x - Math.sin(this.yaw) * Math.cos(this.pitch) * r,
        player.y + 1.6 + Math.sin(this.pitch) * r,
        player.z - Math.cos(this.yaw) * Math.cos(this.pitch) * r,
      );
      L.copy(playerChest).setY(playerChest.y + 0.15);
      rate = 12;
      lookRate = 14;
    } else if (this.mode === "finisher") {
      if (this.modeT < dt * 1.5) {
        const ax = _v.subVectors(boss, player).setY(0).normalize();
        this.finSide.set(-ax.z, 0, ax.x);
        // Pick the side facing the sun so the rim light frames the plunge.
        if (this.finSide.z < 0) this.finSide.negate();
      }
      const mid = _w.lerpVectors(player, boss, 0.5);
      // Fast push-in (~0.12 s) on the cut, then a slow creep through the plunge.
      const push = 1 - Math.pow(1 - clamp(this.modeT / 0.14, 0, 1), 3);
      const u = smooth(clamp(this.modeT / 2.2, 0, 1));
      const r = lerp(3.8, 2.5, push) - 0.4 * u;
      P.copy(mid).addScaledVector(this.finSide, r);
      P.y = lerp(0.7, 1.05, u);
      const toP = _v.subVectors(player, boss).setY(0).normalize();
      P.addScaledVector(toP, -0.5 + u * 0.3);
      L.copy(bossChest).lerp(playerChest, 0.35);
      L.y -= 0.08;
      rate = this.modeT < 0.05 ? 1000 : this.modeT < 0.3 ? 30 : 6;
      lookRate = this.modeT < 0.05 ? 1000 : 8;
    } else if (this.mode === "victory") {
      // Wide, low two-shot that slowly drifts round, framed against the keep and the sun.
      const mid = _w.lerpVectors(player, boss, 0.45);
      const a = 0.35 - this.modeT * 0.04;
      P.set(mid.x + Math.sin(a) * 5.4, 1.2 + this.modeT * 0.03, mid.z + Math.cos(a) * 5.4);
      L.copy(mid).setY(1.25);
      rate = this.modeT < 0.05 ? 1000 : 1.2;
      lookRate = this.modeT < 0.05 ? 1000 : 1.5;
    } else if (this.mode === "death") {
      const a = this.yaw + this.modeT * 0.08;
      P.set(player.x - Math.sin(a) * 3.4, player.y + 2.2, player.z - Math.cos(a) * 3.4);
      L.copy(player);
      L.y += 0.4;
      rate = 1.5;
      lookRate = 2;
    }

    if (this.swap) {
      const u = clamp(this.modeT / 0.4, 0, 1);
      const e = lerp(0.3, 1, smooth(u));
      rate *= e;
      lookRate *= e;
      if (u >= 1) this.swap = false;
    }
    this.wideT = Math.max(0, this.wideT - dt);
    if (this.holdT > 0 && (this.mode === "lock" || this.mode === "free")) {
      this.holdT -= dt;
      P.copy(this.pos);
      L.copy(this.look);
    }
    if (this.wideCut) {
      this.wideCut = false;
      if (this.mode === "lock") rate = lookRate = 1000;
    }
    if (this.override) {
      P.copy(this.override.pos);
      L.copy(this.override.look);
      rate = lookRate = 1000;
    }
    // Stay inside the rooftop (never behind the ridge or out over the eaves).
    if (this.mode !== "title" && this.mode !== "victory" && !this.override) {
      P.x = clamp(P.x, -ARENA_HALF - 2.2, ARENA_HALF + 2.2);
      P.z = clamp(P.z, RIDGE_Z + 0.9, ARENA_HALF + 2.2);
      P.y = Math.max(P.y, 0.45);
    }
    this.pos.lerp(P, damp(rate, dt));
    this.look.lerp(L, damp(lookRate, dt));

    // Trauma shake.
    this.trauma = Math.max(0, this.trauma - dt * 1.5);
    this.fovPunch *= Math.exp(-dt / 0.12);
    const s = this.trauma * this.trauma;
    const n = (f: number, o: number) => Math.sin(this.t * f + o) * 0.6 + Math.sin(this.t * f * 2.3 + o * 3) * 0.4;
    this.cam.position.copy(this.pos);
    this.cam.position.x += n(47, 1) * s * 0.22;
    this.cam.position.y += n(53, 2) * s * 0.18;
    this.cam.position.z += n(41, 3) * s * 0.22;
    this.cam.lookAt(this.look);
    this.cam.rotateZ(n(37, 4) * s * 0.06);
    const fov = this.baseFov - this.fovPunch * 6;
    if (Math.abs(this.cam.fov - fov) > 0.01) {
      this.cam.fov = fov;
      this.cam.updateProjectionMatrix();
    }
  }

  snap(): void {
    this.cam.position.copy(this.pos);
    this.cam.lookAt(this.look);
  }
}
