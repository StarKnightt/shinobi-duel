/**
 * All combat effects in one place: deflect sparks (the hero effect), block sparks, contact
 * flash + a brief orange point light, wind-up glints, the finisher's ink spray and splats, and
 * snow dust kicked up by heavy landings.
 */
import * as THREE from "three";
import { Flash, DeathDot, PerilGlyph } from "./Billboards";
import { Splats, Streaks, coneDir } from "./Particles";

const _d = new THREE.Vector3();
const _p = new THREE.Vector3();
const _side = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

export class Fx {
  readonly sparks = new Streaks(1600, "add");
  /** White flecks keep their colour (no cooling) and fall. */
  readonly flecks = new Streaks(400, "add");
  /** Slow embers that rain down after a deflect, bounce on the snow and cool to red. */
  readonly embers = new Streaks(600, "add");
  readonly smoke = new Streaks(260, "ink");
  readonly ink = new Streaks(900, "ink");
  readonly dust = new Streaks(500, "ink");
  readonly splats = new Splats(320);
  readonly flash = new Flash();
  readonly glintFlash = new Flash();
  readonly streak = new Flash("streak");
  readonly glyph = new PerilGlyph();
  readonly dot = new DeathDot();
  /** The clash lights the night: both fighters, the blades and the snow round their feet. */
  readonly light = new THREE.PointLight(0xff9a40, 0, 16, 1.6);
  private lightTau = 0.07;
  private lightT = 1;
  private lightPeak = 0;
  private readonly R = this.sparks.rand;

  constructor(scene: THREE.Scene) {
    this.sparks.drag = 1.6;
    this.sparks.bounce = 0.42;
    this.ink.gravity = -11;
    this.ink.drag = 0.6;
    this.ink.cooling = false;
    this.ink.onLand = (x, z, s) => this.splats.add(x, z, s);
    this.dust.cooling = false;
    this.dust.gravity = -2.5;
    this.dust.drag = 2.4;
    this.dust.alpha = 0.38;
    this.dust.floorY = -1;
    this.flecks.cooling = false;
    this.flecks.drag = 2.2;
    this.flecks.gravity = -7;
    this.flecks.bounce = 0.3;
    this.smoke.cooling = false;
    this.smoke.gravity = 0.8;
    this.smoke.drag = 3.5;
    this.smoke.alpha = 0.32;
    this.smoke.floorY = -10;
    this.smoke.grow = 1.6;
    this.embers.gravity = -3.2;
    this.embers.drag = 1.1;
    this.embers.bounce = 0.35;
    scene.add(this.embers.mesh, this.flecks.mesh, this.smoke.mesh, this.streak.mesh, this.sparks.mesh, this.ink.mesh, this.dust.mesh, this.splats.mesh, this.flash.mesh, this.glintFlash.mesh, this.dot.mesh, this.light);
  }

  /**
   * Perfect deflect, layered like the reference footage (the burst gone within ~0.3 s, embers
   * linger): a white-hot pin core with a four-point lens star and a screen-wide anamorphic
   * flare, ~220 fast gold needles fanning off the blades, 10-14 long arcing petals, white
   * flecks, a slow rain of embers that bounce on the snow, a puff of dark smoke, and a hard
   * orange light that throws both fighters' shadows for a frame.
   */
  deflect(p: THREE.Vector3, out: THREE.Vector3, power = 1): void {
    const R = this.R;
    const n = Math.round(180 * power);
    // Two wings flung sideways off the blades (screen-wide spray), a little burst all round.
    _side.crossVectors(out, _up).normalize();
    for (let i = 0; i < n; i++) {
      if (i < n * 0.16) coneDir(out, Math.PI, R, _d);
      else {
        _p.copy(_side).multiplyScalar(i & 1 ? 1 : -1).addScaledVector(out, 0.35).addScaledVector(_up, 0.25).normalize();
        coneDir(_p, 0.42, R, _d);
      }
      const sp = 2 + Math.pow(R(), 0.7) * 7.5 * power;
      const hot = R() < 0.35;
      this.sparks.spawn(
        p.x + (R() - 0.5) * 0.05,
        p.y + (R() - 0.5) * 0.05,
        p.z + (R() - 0.5) * 0.05,
        _d.x * sp,
        _d.y * sp,
        _d.z * sp,
        0.08 + R() * 0.22,
        0.004 + R() * 0.006,
        0.014,
        hot ? 14 : 10,
        hot ? 9 : 5.5,
        hot ? 4.5 : 1.7,
      );
    }
    const petals = Math.round((10 + R() * 4) * Math.min(1.4, power));
    for (let i = 0; i < petals; i++) {
      coneDir(out, 1.25, R, _d);
      _d.y += 0.25;
      const sp = 5.5 + R() * 5;
      this.sparks.spawn(p.x, p.y, p.z, _d.x * sp, _d.y * sp, _d.z * sp, 0.28 + R() * 0.2, 0.02 + R() * 0.012, 0.05, 8, 3.6, 1.4);
    }
    for (let i = 0; i < 60 * power; i++) {
      coneDir(out, 1.4, R, _d);
      _d.y += 0.2;
      const sp = 2.5 + R() * 5;
      this.flecks.spawn(p.x, p.y, p.z, _d.x * sp, _d.y * sp, _d.z * sp, 0.25 + R() * 0.3, 0.005, 0.016, 3.2, 3.1, 2.9);
    }
    for (let i = 0; i < 46 * power; i++) {
      coneDir(_p.set(out.x, out.y + 0.8, out.z).normalize(), 1.1, R, _d);
      const sp = 1 + R() * 3.2;
      this.embers.spawn(p.x, p.y, p.z, _d.x * sp, _d.y * sp, _d.z * sp, 0.7 + R() * 0.9, 0.007 + R() * 0.006, 0.02, 9, 4.2, 1.2);
    }
    for (let i = 0; i < 8; i++) {
      coneDir(out, 1.2, R, _d);
      const sp = 0.3 + R() * 0.7;
      this.smoke.spawn(p.x, p.y, p.z, _d.x * sp, _d.y * sp + 0.2, _d.z * sp, 0.4 + R() * 0.2, 0.12 + R() * 0.1, 0.05, 0.05, 0.055, 0.07);
    }
    // No shockwave ring here: the ripple is a refraction in post (Post.shock), not a drawn circle.
    this.flash.fire(p, 0.95 * power, new THREE.Color(14, 9, 5), 0.14, 0, 0.75);
    this.streak.fire(p, 4.2, new THREE.Color(5, 4.2, 3.4), 0.1);
    this.pulseLight(p, 24 * power, 0xffa860, 0.09);
  }

  /** Regular block: dull, sparse sparks. */
  block(p: THREE.Vector3, out: THREE.Vector3): void {
    const R = this.R;
    for (let i = 0; i < 16; i++) {
      coneDir(out, 1.0, R, _d);
      const sp = 1.5 + R() * 4;
      this.sparks.spawn(p.x, p.y, p.z, _d.x * sp, _d.y * sp + 0.8, _d.z * sp, 0.15 + R() * 0.25, 0.008, 0.02, 3.5, 1.5, 0.5);
    }
    this.flash.fire(p, 0.55, new THREE.Color(2.5, 1.6, 1.0), 0.1, 0);
    this.pulseLight(p, 8, 0xffb070);
  }

  /** Blade on armour (player hits the general). */
  armour(p: THREE.Vector3, out: THREE.Vector3, n = 34): void {
    const R = this.R;
    for (let i = 0; i < n; i++) {
      coneDir(out, 1.1, R, _d);
      const sp = 2 + R() * 7;
      this.sparks.spawn(p.x, p.y, p.z, _d.x * sp, _d.y * sp + 1, _d.z * sp, 0.18 + R() * 0.3, 0.009, 0.028, 8, 3.6, 1.1);
    }
    this.flash.fire(p, 0.9, new THREE.Color(6, 3.4, 1.6), 0.12, 0, 0.35);
    this.pulseLight(p, 18, 0xff9a40);
  }

  /** Player is struck: a dark-red stylized burst (no gore). */
  wound(p: THREE.Vector3, out: THREE.Vector3): void {
    const R = this.R;
    for (let i = 0; i < 40; i++) {
      coneDir(out, 0.9, R, _d);
      const sp = 2 + R() * 5;
      this.ink.spawn(p.x, p.y, p.z, _d.x * sp, _d.y * sp + 1, _d.z * sp, 0.4 + R() * 0.4, 0.012 + R() * 0.02, 0.02, 0.35, 0.02, 0.03);
    }
    this.flash.fire(p, 0.8, new THREE.Color(4, 0.3, 0.2), 0.12, 0);
  }

  glint(p: THREE.Vector3, red = false): void {
    this.glintFlash.fire(p, red ? 1.2 : 0.95, red ? new THREE.Color(9, 0.6, 0.3) : new THREE.Color(5, 7, 10), 0.34, 0, 1);
  }

  /** Finisher: a burst of red-black ink droplets plus a hanging ink mist (stylized, no gore). */
  inkBurst(p: THREE.Vector3, dir: THREE.Vector3): void {
    const R = this.R;
    for (let i = 0; i < 300; i++) {
      coneDir(dir, i < 200 ? 0.6 : 1.5, R, _d);
      _d.y += 0.15;
      const sp = 1.2 + Math.pow(R(), 0.8) * 6;
      const dark = R() < 0.5;
      _p.set(p.x + (R() - 0.5) * 0.1, p.y + (R() - 0.5) * 0.1, p.z + (R() - 0.5) * 0.1);
      this.ink.spawn(
        _p.x,
        _p.y,
        _p.z,
        _d.x * sp,
        _d.y * sp,
        _d.z * sp,
        0.35 + R() * 0.45,
        0.022 + R() * 0.03,
        0.003 + R() * 0.004,
        dark ? 0.02 : 0.26 + R() * 0.1,
        dark ? 0.004 : 0.008,
        dark ? 0.005 : 0.01,
      );
    }
    // Hanging red-black ink mist: soft puffs that billow out, swell and fade over ~0.5-0.8 s.
    for (let i = 0; i < 70; i++) {
      coneDir(dir, 1.2, R, _d);
      const sp = 0.4 + R() * 1.6;
      const red = R() < 0.55;
      this.smoke.spawn(
        p.x + (R() - 0.5) * 0.15,
        p.y + (R() - 0.5) * 0.15,
        p.z + (R() - 0.5) * 0.15,
        _d.x * sp,
        _d.y * sp,
        _d.z * sp,
        0.5 + R() * 0.3,
        0.16 + R() * 0.2,
        0,
        red ? 0.42 : 0.05,
        red ? 0.02 : 0.008,
        red ? 0.025 : 0.01,
      );
    }
    this.flash.fire(p, 2.2, new THREE.Color(5, 0.4, 0.25), 0.3, 0, 0.4);
    this.pulseLight(p, 40, 0xff3a20);
  }

  /** A step dodge's first stride: a small, low kick of snow at the feet (never above the knees). */
  kickPuff(p: THREE.Vector3): void {
    const R = this.R;
    for (let i = 0; i < 22; i++) {
      const a = R() * Math.PI * 2;
      const sp = 0.8 + R() * 1.6;
      this.dust.spawn(p.x + Math.cos(a) * 0.15, 0.05 + R() * 0.08, p.z + Math.sin(a) * 0.15, Math.cos(a) * sp, 0.3 + R() * 0.6, Math.sin(a) * sp, 0.35 + R() * 0.3, 0.018 + R() * 0.022, 0.03, 0.42, 0.47, 0.6);
    }
  }

  /** Heavy landing: snow dust ring + a few sparks where the blade hits the tiles. */
  slam(p: THREE.Vector3): void {
    const R = this.R;
    // Kept low and small so the fighters stay readable through it.
    for (let i = 0; i < 100; i++) {
      const a = R() * Math.PI * 2;
      const sp = 2 + R() * 5;
      this.dust.spawn(
        p.x + Math.cos(a) * 0.3,
        0.1 + R() * 0.15,
        p.z + Math.sin(a) * 0.3,
        Math.cos(a) * sp,
        0.4 + R() * 1.2,
        Math.sin(a) * sp,
        0.45 + R() * 0.5,
        0.022 + R() * 0.035,
        0.03,
        0.42,
        0.47,
        0.6,
      );
    }
  }

  /** Posture break: a grey wind-and-snow burst radiating from the general. */
  breakBurst(p: THREE.Vector3): void {
    const R = this.R;
    for (let i = 0; i < 120; i++) {
      const a = R() * Math.PI * 2;
      const up = (R() - 0.3) * 0.8;
      const sp = 3 + R() * 4;
      const v = 0.4 + R() * 0.14;
      this.smoke.spawn(p.x, p.y + (R() - 0.5) * 0.6, p.z, Math.cos(a) * sp, up * sp, Math.sin(a) * sp, 0.35 + R() * 0.25, 0.14 + R() * 0.18, 0.06, v, v, v * 1.04);
    }
  }

  private pulseLight(p: THREE.Vector3, peak: number, color: number, tau = 0.07): void {
    this.light.position.copy(p);
    this.light.color.setHex(color);
    this.lightPeak = peak;
    this.lightT = 0;
    this.lightTau = tau;
  }

  /** Real-time effects (keep moving through hitstop). */
  updateReal(dt: number): void {
    this.sparks.update(dt);
    this.flecks.update(dt);
    this.embers.update(dt);
    this.smoke.update(dt);
    this.flash.update(dt);
    this.streak.update(dt);
    this.glintFlash.update(dt);
    this.lightT += dt;
    this.light.intensity = this.lightPeak * Math.exp(-this.lightT / this.lightTau);
  }

  /** Game-time effects (slow down with the finisher). */
  updateGame(dt: number): void {
    this.ink.update(dt);
    this.dust.update(dt);
  }

  clear(): void {
    this.sparks.clear();
    this.flecks.clear();
    this.embers.clear();
    this.smoke.clear();
    this.ink.clear();
    this.dust.clear();
    this.splats.clear();
    this.glyph.hide();
    this.dot.active = false;
  }
}
