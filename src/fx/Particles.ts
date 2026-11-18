/**
 * Velocity-stretched streak particles, simulated on the CPU and drawn as one instanced quad
 * batch. Used for the hero sparks (additive HDR, bouncing off the tiles) and for the finisher's
 * ink spray (normal blending, heavy, leaves splats on the roof).
 */
import * as THREE from "three";
import { rng } from "../core/math";

const VERT = /* glsl */ `
attribute vec3 iPos;
attribute vec3 iVel;
attribute vec4 iCol;
attribute vec2 iSize; // width, stretch
varying vec2 vC;
varying vec4 vCol;
void main() {
  vec4 vp = viewMatrix * vec4(iPos, 1.0);
  vec3 vv = (viewMatrix * vec4(iVel, 0.0)).xyz;
  vec2 ax = vv.xy;
  float sp = length(ax);
  ax = sp > 1e-4 ? ax / sp : vec2(0.0, 1.0);
  vec2 side = vec2(ax.y, -ax.x); // keeps the quad counter-clockwise (front-facing)
  float len = iSize.x * 1.5 + sp * iSize.y;
  vec2 c = position.xy; // x in [-1,1], y in [-1,0.25]
  vp.xy += ax * c.y * len + side * c.x * iSize.x;
  vC = c;
  vCol = iCol;
  gl_Position = projectionMatrix * vp;
}`;

const FRAG_ADD = /* glsl */ `
varying vec2 vC;
varying vec4 vCol;
void main() {
  float w = 1.0 - abs(vC.x);
  float l = smoothstep(-1.0, -0.2, vC.y) * (1.0 - smoothstep(0.0, 0.25, vC.y));
  float a = w * w * l;
  gl_FragColor = vec4(vCol.rgb * a * vCol.a, 1.0);
}`;

const FRAG_INK = /* glsl */ `
varying vec2 vC;
varying vec4 vCol;
void main() {
  vec2 q = vec2(vC.x, (vC.y + 0.4) * 1.6);
  float d = length(q);
  float a = (1.0 - smoothstep(0.25, 1.0, d)) * vCol.a;
  if (a < 0.02) discard;
  gl_FragColor = vec4(vCol.rgb, a);
}`;

export class Streaks {
  readonly mesh: THREE.Mesh;
  private readonly geo: THREE.InstancedBufferGeometry;
  private readonly max: number;
  private pos: Float32Array;
  private vel: Float32Array;
  private col: Float32Array;
  private size: Float32Array;
  private life: Float32Array;
  private maxLife: Float32Array;
  private base: Float32Array; // rgb base colour
  private alive = 0;
  private aPos: THREE.InstancedBufferAttribute;
  private aVel: THREE.InstancedBufferAttribute;
  private aCol: THREE.InstancedBufferAttribute;
  private aSize: THREE.InstancedBufferAttribute;
  gravity = -9.8;
  drag = 1.2;
  bounce = 0.35;
  floorY = 0.04;
  /** Sparks cool white → orange → red; ink/snow keep their colour and just fade. */
  cooling = true;
  alpha = 1;
  /** Width multiplier gained over a particle's life (soft mist puffs swell as they fade). */
  grow = 0;
  /** Side-to-side sway (m/s²) so light things seesaw down like feathers instead of dropping. */
  flutter = 0;
  /** Called when a particle hits the floor (ink splats). */
  onLand: ((x: number, z: number, size: number) => void) | null = null;
  readonly rand = rng(1234);

  constructor(max: number, kind: "add" | "ink") {
    this.max = max;
    const quad = new THREE.BufferGeometry();
    quad.setAttribute(
      "position",
      new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 0.25, 0, -1, 0.25, 0], 3),
    );
    quad.setIndex([0, 1, 2, 0, 2, 3]);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = quad.index;
    geo.setAttribute("position", quad.getAttribute("position"));
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.col = new Float32Array(max * 4);
    this.size = new Float32Array(max * 2);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.base = new Float32Array(max * 3);
    const mk = (arr: Float32Array, n: number) => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(arr.length), n);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    this.aPos = mk(this.pos, 3);
    this.aVel = mk(this.vel, 3);
    this.aCol = mk(this.col, 4);
    this.aSize = mk(this.size, 2);
    geo.setAttribute("iPos", this.aPos);
    geo.setAttribute("iVel", this.aVel);
    geo.setAttribute("iCol", this.aCol);
    geo.setAttribute("iSize", this.aSize);
    geo.instanceCount = 0;
    this.geo = geo;
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: kind === "add" ? FRAG_ADD : FRAG_INK,
      transparent: true,
      depthWrite: false,
      blending: kind === "add" ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = kind === "add" ? 5 : 4;
  }

  spawn(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    life: number,
    width: number,
    stretch: number,
    r: number,
    g: number,
    b: number,
  ): void {
    if (this.alive >= this.max) return;
    const i = this.alive++;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx;
    this.vel[i * 3 + 1] = vy;
    this.vel[i * 3 + 2] = vz;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.size[i * 2] = width;
    this.size[i * 2 + 1] = stretch;
    this.base[i * 3] = r;
    this.base[i * 3 + 1] = g;
    this.base[i * 3 + 2] = b;
  }

  update(dt: number): void {
    const R = this.rand;
    let w = 0;
    const dragK = Math.exp(-this.drag * dt);
    for (let i = 0; i < this.alive; i++) {
      let life = this.life[i] - dt;
      if (life <= 0) continue;
      let px = this.pos[i * 3];
      let py = this.pos[i * 3 + 1];
      let pz = this.pos[i * 3 + 2];
      let vx = this.vel[i * 3] * dragK;
      let vy = this.vel[i * 3 + 1] * dragK + this.gravity * dt;
      let vz = this.vel[i * 3 + 2] * dragK;
      if (this.flutter) {
        // Phase from the particle's own lifetime (stable through compaction).
        const ph = this.maxLife[i] * 97.1;
        const age = this.maxLife[i] - life;
        vx += Math.sin(age * 5.2 + ph) * this.flutter * dt;
        vz += Math.cos(age * 4.6 + ph * 1.3) * this.flutter * dt;
      }
      px += vx * dt;
      py += vy * dt;
      pz += vz * dt;
      if (py < this.floorY && vy < 0) {
        py = this.floorY;
        if (this.onLand) {
          this.onLand(px, pz, this.size[i * 2]);
          life = 0;
          continue;
        }
        vy = -vy * this.bounce * (0.6 + R() * 0.6);
        vx *= 0.6;
        vz *= 0.6;
        life *= 0.7;
      }
      // Compact in place.
      this.pos[w * 3] = px;
      this.pos[w * 3 + 1] = py;
      this.pos[w * 3 + 2] = pz;
      this.vel[w * 3] = vx;
      this.vel[w * 3 + 1] = vy;
      this.vel[w * 3 + 2] = vz;
      this.life[w] = life;
      this.maxLife[w] = this.maxLife[i];
      this.size[w * 2] = this.size[i * 2];
      this.size[w * 2 + 1] = this.size[i * 2 + 1];
      this.base[w * 3] = this.base[i * 3];
      this.base[w * 3 + 1] = this.base[i * 3 + 1];
      this.base[w * 3 + 2] = this.base[i * 3 + 2];
      w++;
    }
    this.alive = w;
    const P = this.aPos.array as Float32Array;
    const V = this.aVel.array as Float32Array;
    const C = this.aCol.array as Float32Array;
    const S = this.aSize.array as Float32Array;
    for (let i = 0; i < w; i++) {
      const k = this.life[i] / this.maxLife[i];
      P[i * 3] = this.pos[i * 3];
      P[i * 3 + 1] = this.pos[i * 3 + 1];
      P[i * 3 + 2] = this.pos[i * 3 + 2];
      V[i * 3] = this.vel[i * 3];
      V[i * 3 + 1] = this.vel[i * 3 + 1];
      V[i * 3 + 2] = this.vel[i * 3 + 2];
      // Sparks cool from white-hot to orange to dark red as they die.
      if (this.cooling) {
        const heat = k * k;
        C[i * 4] = this.base[i * 3] * (0.35 + 0.65 * k);
        C[i * 4 + 1] = this.base[i * 3 + 1] * (0.12 + 0.88 * heat);
        C[i * 4 + 2] = this.base[i * 3 + 2] * heat;
        C[i * 4 + 3] = Math.min(1, k * 3);
      } else {
        C[i * 4] = this.base[i * 3];
        C[i * 4 + 1] = this.base[i * 3 + 1];
        C[i * 4 + 2] = this.base[i * 3 + 2];
        C[i * 4 + 3] = Math.min(1, k * 2) * this.alpha;
      }
      S[i * 2] = this.size[i * 2] * (1 + this.grow * (1 - k));
      S[i * 2 + 1] = this.size[i * 2 + 1];
    }
    this.geo.instanceCount = w;
    this.aPos.needsUpdate = this.aVel.needsUpdate = this.aCol.needsUpdate = this.aSize.needsUpdate = true;
    this.aPos.addUpdateRange(0, w * 3);
    this.aVel.addUpdateRange(0, w * 3);
    this.aCol.addUpdateRange(0, w * 4);
    this.aSize.addUpdateRange(0, w * 2);
  }

  get count(): number {
    return this.alive;
  }

  clear(): void {
    this.alive = 0;
    this.geo.instanceCount = 0;
  }
}

const _d = new THREE.Vector3();
const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();

/** Random direction in a cone around `dir` (half-angle `spread` radians). */
export function coneDir(dir: THREE.Vector3, spread: number, R: () => number, out: THREE.Vector3): THREE.Vector3 {
  _t1.set(Math.abs(dir.y) < 0.9 ? 0 : 1, Math.abs(dir.y) < 0.9 ? 1 : 0, 0).cross(dir).normalize();
  _t2.crossVectors(dir, _t1);
  const a = R() * Math.PI * 2;
  const c = Math.cos(spread);
  const z = c + (1 - c) * R();
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  _d.copy(dir).multiplyScalar(z).addScaledVector(_t1, Math.cos(a) * r).addScaledVector(_t2, Math.sin(a) * r);
  return out.copy(_d).normalize();
}

/** Flat ink splats on the roof (instanced discs with a ragged texture). */
export class Splats {
  readonly mesh: THREE.InstancedMesh;
  private n = 0;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly R = rng(77);

  constructor(max = 260) {
    const tex = (() => {
      const c = document.createElement("canvas");
      c.width = c.height = 128;
      const g = c.getContext("2d")!;
      const R = rng(3);
      g.fillStyle = "#fff";
      g.beginPath();
      g.arc(64, 64, 34, 0, Math.PI * 2);
      g.fill();
      for (let i = 0; i < 14; i++) {
        const a = R() * Math.PI * 2;
        const r = 30 + R() * 30;
        g.beginPath();
        g.arc(64 + Math.cos(a) * r, 64 + Math.sin(a) * r, 3 + R() * 9, 0, Math.PI * 2);
        g.fill();
      }
      const t = new THREE.CanvasTexture(c);
      return t;
    })();
    const mat = new THREE.MeshBasicMaterial({
      color: 0x1a0304,
      alphaMap: tex,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
    });
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
  }

  add(x: number, z: number, s: number): void {
    const i = this.n % this.mesh.instanceMatrix.count;
    this.n++;
    this.q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.R() * 6.28);
    const sc = s * (6 + this.R() * 8);
    this.m.compose(new THREE.Vector3(x, 0.075 + this.R() * 0.01, z), this.q, new THREE.Vector3(sc, 1, sc));
    this.mesh.setMatrixAt(i, this.m);
    this.mesh.count = Math.min(this.n, this.mesh.instanceMatrix.count);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  clear(): void {
    this.n = 0;
    this.mesh.count = 0;
  }
}
