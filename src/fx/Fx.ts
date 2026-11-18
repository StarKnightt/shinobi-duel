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
  /** Rising additive motes that keep their colour: curse fire, heal motes, rage embers. */
  readonly wisps = new Streaks(1800, "add");
  /** Black crow feathers (normal blending), drifting down. */
  readonly feathers = new Streaks(1100, "ink");
  /** Dark smoke that rises (the curse's black edge, the rage's heat haze, the crow's shadow). */
  readonly haze = new Streaks(500, "ink");
  /**
   * Steady glows that travel with a fighter (curse / heal on her, rage on him). Always in the
   * scene (intensity 0 when off) so turning one on never recompiles a shader.
   */
  readonly herLight = new THREE.PointLight(0x9a5cff, 0, 2.2, 2);
  private readonly curseTip = new THREE.Vector3();
  curseTipOk = false;
  readonly hisLight = new THREE.PointLight(0xff3a28, 0, 2.6, 2);
  /** Firecracker pops still to go off (seconds from now, where). */
  private pops: { t: number; p: THREE.Vector3; big: boolean }[] = [];
  /** Each firecracker crack (the game turns it into sound). */
  onPop: ((big: boolean) => void) | null = null;

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
    this.wisps.cooling = false;
    this.wisps.gravity = 1.6;
    this.wisps.drag = 2.4;
    this.wisps.floorY = -10;
    this.feathers.cooling = false;
    this.feathers.gravity = -1.1;
    this.feathers.drag = 3.2;
    this.feathers.flutter = 7;
    this.feathers.alpha = 0.92;
    this.feathers.floorY = 0.02;
    this.feathers.bounce = 0;
    this.haze.cooling = false;
    this.haze.gravity = 0.9;
    this.haze.drag = 2.8;
    this.haze.alpha = 0.3;
    this.haze.floorY = -10;
    this.haze.grow = 1.8;
    scene.add(this.wisps.mesh, this.feathers.mesh, this.haze.mesh, this.herLight, this.hisLight);
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
        hot ? 7.6 : 4.2,
        hot ? 3.2 : 1.0,
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
      this.embers.spawn(p.x, p.y, p.z, _d.x * sp, _d.y * sp, _d.z * sp, 1.0 + R() * 1.2, 0.007 + R() * 0.006, 0.02, 9, 4.2, 1.2);
    }
    for (let i = 0; i < 8; i++) {
      coneDir(out, 1.2, R, _d);
      const sp = 0.3 + R() * 0.7;
      this.smoke.spawn(p.x, p.y, p.z, _d.x * sp, _d.y * sp + 0.2, _d.z * sp, 0.4 + R() * 0.2, 0.12 + R() * 0.1, 0.05, 0.05, 0.055, 0.07);
    }
    // No shockwave ring here: the ripple is a refraction in post (Post.shock), not a drawn circle.
    this.flash.fire(p, 0.95 * power, new THREE.Color(14, 9, 5), 0.14, 0, 0.75);
    // Reference (Sekiro deflects): a long thin orange flare line across the frame that outlives
    // the core, and a warm pool of light on the ground under the blades for about half a second.
    this.streak.fire(p, 16, new THREE.Color(7, 2.1, 0.5).multiplyScalar(Math.min(1.3, power)), 0.34);
    this.pulseLight(p, 22 * power, 0xff9a48, 0.17);
  }

  // ------------------------------------------------------------------ abilities

  /** 1, ignition: the curse runs up the blade from the hilt in a violet flare. */
  curseIgnite(hilt: THREE.Vector3, tip: THREE.Vector3): void {
    const R = this.R;
    for (let i = 0; i < 60; i++) {
      _p.lerpVectors(hilt, tip, R());
      const a = R() * Math.PI * 2;
      const sp = 0.6 + R() * 2.2;
      const hot = R() < 0.3;
      this.wisps.spawn(_p.x, _p.y, _p.z, Math.cos(a) * sp, 0.6 + R() * 1.6, Math.sin(a) * sp, 0.25 + R() * 0.3, 0.02 + R() * 0.03, 0.02, hot ? 1.8 : 0.6, hot ? 1.3 : 0.2, hot ? 2.6 : 1.3);
    }
    for (let i = 0; i < 10; i++) {
      _p.lerpVectors(hilt, tip, R());
      this.haze.spawn(_p.x, _p.y, _p.z, (R() - 0.5) * 0.6, 0.4 + R() * 0.5, (R() - 0.5) * 0.6, 0.6 + R() * 0.4, 0.06 + R() * 0.05, 0.05, 0.06, 0.02, 0.1);
    }
    this.flash.fire(_p.lerpVectors(hilt, tip, 0.5), 0.5, new THREE.Color(1.3, 0.6, 2.6), 0.14, 0, 0.2);
  }

  /**
   * 1, burning: purple fire licking off the blade (pale at the heart, dark at the edges: a hot
   * violet core and black-violet smoke) and its glow on her.
   */
  curseBlade(hilt: THREE.Vector3, tip: THREE.Vector3, dt: number, k: number): void {
    const R = this.R;
    // Blade speed (m/s at the tip): a swing sheds a trail of fire behind it.
    const sp = this.curseTipOk && dt > 0 ? Math.min(30, this.curseTip.distanceTo(tip) / dt) : 0;
    this.curseTip.copy(tip);
    this.curseTipOk = true;
    // Tongues along the whole blade: violet bodies, a few pale cores (#D9B8FF), each one licking
    // up off the steel and thinning. Spread off the blade line so they never stack into a bar.
    const n = Math.floor(dt * (230 + sp * 30) * k + R());
    for (let i = 0; i < n; i++) {
      const u = R();
      _p.lerpVectors(hilt, tip, 0.08 + u * 0.92);
      _p.x += (R() - 0.5) * 0.08;
      _p.y += (R() - 0.5) * 0.03;
      _p.z += (R() - 0.5) * 0.08;
      const hot = R() < 0.13;
      const w = hot ? 0.014 + R() * 0.012 : 0.03 + R() * 0.04;
      const life = hot ? 0.1 + R() * 0.12 : 0.2 + R() * 0.24;
      const f = 0.7 + 0.3 * u; // fuller toward the tip
      this.wisps.spawn(_p.x, _p.y, _p.z, (R() - 0.5) * 0.8, 1.1 + R() * 1.4, (R() - 0.5) * 0.8, life, w * f, 0.06, hot ? 1.1 : 0.3, hot ? 0.85 : 0.06, hot ? 1.55 : 0.78);
    }
    // Trail: on a swing, long slow wisps left hanging in the arc.
    if (sp > 3) {
      const m = Math.floor(dt * sp * 22 * k + R());
      for (let i = 0; i < m; i++) {
        _p.lerpVectors(hilt, tip, 0.35 + R() * 0.65);
        this.wisps.spawn(_p.x, _p.y, _p.z, (R() - 0.5) * 0.3, 0.3 + R() * 0.5, (R() - 0.5) * 0.3, 0.35 + R() * 0.3, 0.035 + R() * 0.03, 0.03, 0.32, 0.06, 0.8);
      }
    }
    // Dark edges: violet-black smoke (#1A0B2A) curling off the flames.
    const h = Math.floor(dt * 70 * k + R());
    for (let i = 0; i < h; i++) {
      _p.lerpVectors(hilt, tip, 0.15 + R() * 0.85);
      this.haze.spawn(_p.x + (R() - 0.5) * 0.06, _p.y + 0.04, _p.z + (R() - 0.5) * 0.06, (R() - 0.5) * 0.25, 0.5 + R() * 0.5, (R() - 0.5) * 0.25, 0.45 + R() * 0.35, 0.05 + R() * 0.05, 0.05, 0.1, 0.045, 0.165);
    }
    // Violet light on her and a pool on the snow (short reach: no wash over the roof).
    this.herLight.color.setHex(0x8a4cff);
    this.herLight.distance = 4;
    this.herLight.position.lerpVectors(hilt, tip, 0.55);
    this.herLight.intensity = 5 * k * (0.85 + 0.15 * Math.sin(performance.now() * 0.031) * Math.sin(performance.now() * 0.017 + 1));
  }

  /** 2: a fistful of firecrackers flung ahead: a flash, then a string of cracks, sparks and smoke. */
  crackers(p: THREE.Vector3, dir: THREE.Vector3): void {
    const R = this.R;
    this.flash.fire(p, 1.1, new THREE.Color(12, 8, 4.5), 0.12, 0, 0.6);
    this.pulseLight(p, 30, 0xffb060, 0.12);
    for (let i = 0; i < 9; i++) {
      _d.copy(dir).multiplyScalar(0.6 + R() * 2.4);
      _d.x += (R() - 0.5) * 2.2;
      _d.z += (R() - 0.5) * 2.2;
      this.pops.push({ t: 0.04 + i * 0.055 + R() * 0.05, p: p.clone().add(_d).setY(0.2 + R() * 1.3), big: i === 0 || R() < 0.25 });
    }
  }

  private pop(p: THREE.Vector3, big: boolean): void {
    const R = this.R;
    const n = big ? 60 : 34;
    for (let i = 0; i < n; i++) {
      const a = R() * Math.PI * 2;
      const up = R() * 1.6 - 0.4;
      const sp = 3 + R() * (big ? 7 : 5);
      const hot = R() < 0.4;
      this.sparks.spawn(p.x, p.y, p.z, Math.cos(a) * sp, up * sp * 0.6, Math.sin(a) * sp, 0.1 + R() * 0.25, 0.004 + R() * 0.006, 0.014, hot ? 14 : 10, hot ? 9 : 4.6, hot ? 4 : 1.2);
    }
    for (let i = 0; i < (big ? 5 : 3); i++) {
      const v = 0.14 + R() * 0.08;
      this.smoke.spawn(p.x, p.y, p.z, (R() - 0.5) * 1.2, 0.3 + R() * 0.6, (R() - 0.5) * 1.2, 0.8 + R() * 0.5, 0.14 + R() * 0.14, 0.05, v * 0.95, v, v * 1.12);
    }
    this.glintFlash.fire(p, big ? 0.75 : 0.5, new THREE.Color(9, 6, 3), 0.07, 0, big ? 0.6 : 0.3);
    this.pulseLight(p, big ? 26 : 16, 0xffa850, 0.06);
    this.onPop?.(big);
  }

  /** 3: a burst of black feathers and shadow where she was (or where she comes out). */
  feathersBurst(p: THREE.Vector3, n = 70): void {
    const R = this.R;
    // A vortex: flung out and round (tangential spin), then they seesaw slowly down (flutter, drag).
    const spin = R() < 0.5 ? 1 : -1;
    for (let i = 0; i < n * 3.2; i++) {
      const a = R() * Math.PI * 2;
      const sr = 1.2 + R() * 3.6;
      const st = spin * (1.5 + R() * 3.2);
      const y = p.y + 0.15 + R() * 1.8;
      const c = Math.cos(a);
      const sn = Math.sin(a);
      const v = 0.012 + R() * 0.03;
      const big = R() < 0.3;
      this.feathers.spawn(p.x + c * 0.25, y, p.z + sn * 0.25, c * sr - sn * st, 0.6 + R() * 3.2, sn * sr + c * st, 2.0 + R() * 1.8, big ? 0.03 + R() * 0.02 : 0.014 + R() * 0.014, 0.04, v, v, v * 1.35);
    }
    for (let i = 0; i < 26; i++) {
      const a = R() * Math.PI * 2;
      this.haze.spawn(p.x, p.y + 0.3 + R() * 1.2, p.z, Math.cos(a) * 1.2, 0.2 + R() * 0.5, Math.sin(a) * 1.2, 0.5 + R() * 0.4, 0.18 + R() * 0.16, 0.05, 0.02, 0.022, 0.04);
    }
  }

  /** Gourd: soft jade motes rising round her body while the medicine takes. */
  healMotes(hips: THREE.Vector3, head: THREE.Vector3, dt: number, k: number): void {
    const R = this.R;
    const n = Math.floor(dt * 110 * k + R());
    for (let i = 0; i < n; i++) {
      const a = R() * Math.PI * 2;
      const r = 0.22 + R() * 0.24;
      _p.lerpVectors(hips, head, R() * 1.1 - 0.4);
      const v = 0.6 + R() * 0.6;
      this.wisps.spawn(_p.x + Math.cos(a) * r, Math.max(0.05, _p.y), _p.z + Math.sin(a) * r, -Math.cos(a) * 0.1, 0.25 + R() * 0.35, -Math.sin(a) * 0.1, 0.7 + R() * 0.6, 0.011 + R() * 0.009, 0.004, 0.7 * v, 2.1 * v, 1.4 * v);
    }
    this.herLight.color.setHex(0x7fd8b0);
    this.herLight.distance = 2.2;
    this.herLight.position.lerpVectors(hips, head, 0.5);
    this.herLight.intensity = 0.8 * k;
  }

  /**
   * Phase 2: red-black heat off his armour: embers rising off the plates, dark heat haze, and the
   * eyes in the menpo burning (two tiny hot points a few cm in front of the face).
   */
  rage(hips: THREE.Vector3, chest: THREE.Vector3, head: THREE.Vector3, yaw: number, dt: number, k: number, t: number): void {
    const R = this.R;
    const surge = 0.8 + 0.2 * Math.sin(t * 2.3) * Math.sin(t * 5.1 + 2);
    // Aura: dark blood-red flame licking up the whole body, feet to horns (#B3121E → black).
    const fl = Math.floor(dt * 210 * k * surge + R());
    for (let i = 0; i < fl; i++) {
      const v = R();
      _p.set(hips.x, 0.05, hips.z).lerp(head, Math.min(1.08, v * 1.15));
      const a = R() * Math.PI * 2;
      const r = (0.24 + R() * 0.16) * (1 - 0.35 * v);
      const hot = R() < 0.12;
      this.wisps.spawn(_p.x + Math.cos(a) * r, _p.y, _p.z + Math.sin(a) * r, Math.cos(a) * 0.15, 0.9 + R() * 1.2, Math.sin(a) * 0.15, 0.25 + R() * 0.3, hot ? 0.025 + R() * 0.015 : 0.05 + R() * 0.06, 0.06, hot ? 4 : 2.0, hot ? 0.55 : 0.1, hot ? 0.18 : 0.04);
    }
    // Embers pouring off the armour: many, small, some hot, rising and drifting on the wind.
    const n = Math.floor(dt * 170 * k + R());
    for (let i = 0; i < n; i++) {
      _p.lerpVectors(hips, head, R() * 1.05);
      const a = R() * Math.PI * 2;
      const r = 0.2 + R() * 0.22;
      const hot = R() < 0.35;
      this.wisps.spawn(_p.x + Math.cos(a) * r, _p.y, _p.z + Math.sin(a) * r, (R() - 0.5) * 0.6, 1.0 + R() * 1.8, (R() - 0.5) * 0.6, 0.7 + R() * 0.9, 0.007 + R() * 0.008, 0.05, hot ? 6 : 2.2, hot ? 1.2 : 0.15, hot ? 0.35 : 0.04);
    }
    // Black smoke rolling up off him (the dark half of the aura).
    const h = Math.floor(dt * 45 * k + R());
    for (let i = 0; i < h; i++) {
      _p.lerpVectors(hips, head, R());
      this.haze.spawn(_p.x + (R() - 0.5) * 0.55, _p.y, _p.z + (R() - 0.5) * 0.55, (R() - 0.5) * 0.3, 0.7 + R() * 0.6, (R() - 0.5) * 0.3, 0.8 + R() * 0.6, 0.16 + R() * 0.16, 0.05, 0.045, 0.006, 0.006);
    }
    // Eyes: a pair of hot points in the menpo, re-laid every step so they track the head.
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    const flick = 0.8 + 0.2 * Math.sin(t * 23) * Math.sin(t * 7.3);
    for (const sd of [-1, 1]) {
      const ex = head.x + fx * 0.15 + fz * 0.042 * sd;
      const ez = head.z + fz * 0.15 - fx * 0.042 * sd;
      this.wisps.spawn(ex, head.y + 0.015, ez, 0, 0, 0, 0.05, 0.04 * k, 0.02, 18 * flick * k, 2.6 * flick * k, 0.9 * k);
    }
    // A red pool of light on the snow around him, breathing with the flames.
    this.hisLight.distance = 6;
    this.hisLight.decay = 1.3;
    this.hisLight.position.set(chest.x, 0.45, chest.z);
    this.hisLight.intensity = 18 * k * surge;
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

  /**
   * Her cut lands on him: a fan of dark blood-ink thrown along the blade's travel (no gore, it
   * reads as ink), a few lacquer chips, and with the curse a lick of violet fire off the wound.
   */
  cutSpray(p: THREE.Vector3, out: THREE.Vector3, k: number, cursed: boolean): void {
    const R = this.R;
    const n = Math.round(30 * k);
    for (let i = 0; i < n; i++) {
      coneDir(out, 0.75, R, _d);
      const sp = 2.5 + R() * 5.5 * k;
      this.ink.spawn(p.x, p.y, p.z, _d.x * sp, _d.y * sp + 1.2, _d.z * sp, 0.35 + R() * 0.4, 0.01 + R() * 0.018, 0.025, 0.32, 0.02, 0.03);
    }
    if (cursed) {
      for (let i = 0; i < 24; i++) {
        coneDir(out, 1.2, R, _d);
        const sp = 0.8 + R() * 2.2;
        const hot = R() < 0.25;
        this.wisps.spawn(p.x, p.y, p.z, _d.x * sp, _d.y * sp + 0.8, _d.z * sp, 0.2 + R() * 0.25, 0.018 + R() * 0.02, 0.06, hot ? 1.4 : 0.4, hot ? 1.0 : 0.12, hot ? 2.0 : 0.95);
      }
    }
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
    this.wisps.update(dt);
    this.feathers.update(dt);
    this.haze.update(dt);
    for (let i = this.pops.length - 1; i >= 0; i--) {
      const q = this.pops[i];
      q.t -= dt;
      if (q.t <= 0) {
        this.pops.splice(i, 1);
        this.pop(q.p, q.big);
      }
    }
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
    this.wisps.clear();
    this.feathers.clear();
    this.haze.clear();
    this.pops.length = 0;
    this.herLight.intensity = 0;
    this.curseTipOk = false;
    this.hisLight.intensity = 0;
    this.glyph.hide();
    this.dot.active = false;
  }
}
