/**
 * Camera-facing quads: the deflect contact flash (star burst), the red peril glyph above the
 * boss, and the glowing red dot that marks a broken posture.
 */
import * as THREE from "three";
import { brushText } from "../ui/brush";

const BB_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  vec2 s = vec2(length(modelMatrix[0].xyz), length(modelMatrix[1].xyz));
  mv.xy += position.xy * s;
  gl_Position = projectionMatrix * mv;
}`;

/**
 * Contact flash. "burst": hot core + soft halo + an expanding shockwave ring.
 * "streak": a thin screen-horizontal flare line through the contact point.
 */
export class Flash {
  readonly mesh: THREE.Mesh;
  private readonly mat: THREE.ShaderMaterial;
  private t = 1;
  private dur = 0.18;
  private size = 1;

  constructor(private readonly kind: "burst" | "streak" = "burst") {
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uT: { value: 1 }, uC: { value: new THREE.Color(9, 5, 2.4) }, uRing: { value: 1 }, uRays: { value: 0 } },
      vertexShader: BB_VERT,
      fragmentShader:
        kind === "burst"
          ? /* glsl */ `
        uniform float uT; uniform vec3 uC; uniform float uRing; uniform float uRays; varying vec2 vUv;
        void main() {
          vec2 p = (vUv - 0.5) * 2.0;
          float r = length(p);
          float star = uRays * (exp(-abs(p.y) * 60.0) * exp(-abs(p.x) * 3.0) + exp(-abs(p.x) * 60.0) * exp(-abs(p.y) * 3.0));
          float k = 1.0 - uT;
          float core = exp(-r * r * 90.0);
          float halo = exp(-r * 4.5) * 0.22;
          float rr = 0.25 + 0.7 * (1.0 - pow(1.0 - uT, 3.0));
          float dr = (r - rr) * 34.0;
          float ring = exp(-dr * dr) * uRing * k * 0.6;
          vec3 col = uC * (core * 1.6 + halo + star) * k * k + uC * vec3(1.0, 0.75, 0.55) * ring * 0.55;
          gl_FragColor = vec4(col, 1.0);
        }`
          : /* glsl */ `
        uniform float uT; uniform vec3 uC; varying vec2 vUv;
        void main() {
          vec2 p = (vUv - 0.5) * 2.0;
          float line = exp(-p.y * p.y * 900.0) + exp(-p.y * p.y * 60.0) * 0.08;
          // pow() of a negative base is undefined (NaN on some GPUs, and the bloom spreads it over the frame).
          float along = pow(max(1.0 - abs(p.x), 0.0), 1.6);
          float k = 1.0 - uT;
          gl_FragColor = vec4(uC * line * along * k * k, 1.0);
        }`,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 8;
    this.mesh.visible = false;
  }

  fire(p: THREE.Vector3, size: number, color?: THREE.Color, dur = 0.18, ring = 1, rays = 0): void {
    this.mat.uniforms.uRays.value = rays;
    this.mesh.position.copy(p);
    this.t = 0;
    this.dur = dur;
    this.size = size;
    this.mat.uniforms.uRing.value = ring;
    if (color) this.mat.uniforms.uC.value.copy(color);
    else this.mat.uniforms.uC.value.setRGB(9, 5, 2.4);
    this.mesh.visible = true;
    this.update(0);
  }

  update(dt: number): void {
    if (!this.mesh.visible) return;
    this.t += dt / this.dur;
    if (this.t >= 1) {
      this.mesh.visible = false;
      return;
    }
    this.mat.uniforms.uT.value = this.t;
    if (this.kind === "streak") this.mesh.scale.set(this.size, this.size * 0.06, 1);
    else {
      const s = this.size * (0.85 + this.t * 0.3);
      this.mesh.scale.set(s, s, 1);
    }
  }
}

const _proj = new THREE.Vector3();

/**
 * Red brush kanji warning above the boss for the unblockable thrust. Drawn as a DOM overlay
 * (after post-processing) so bloom and the sun's light shafts behind the boss can't wash it out.
 */
export class PerilGlyph {
  private readonly el: HTMLDivElement;
  private t = 0;
  private a = 0;
  private visible = false;
  active = false;

  constructor() {
    const c = brushText("危", { size: 200, weight: 700, color: "#c8160c", seed: 11, dry: 0.3, splatter: 0.25 });
    this.el = document.createElement("div");
    this.el.style.cssText =
      "position:fixed;left:0;top:0;width:17vh;height:17vh;pointer-events:none;opacity:0;z-index:5;will-change:transform,opacity;" +
      "background:radial-gradient(closest-side, rgba(12,2,2,0.72), rgba(12,2,2,0.45) 55%, rgba(12,2,2,0) 100%);";
    const img = new Image();
    img.src = c.toDataURL();
    img.style.cssText = "width:100%;height:100%;object-fit:contain;filter:drop-shadow(0 0 6px rgba(255,40,20,0.55));";
    this.el.appendChild(img);
    document.body.appendChild(this.el);
  }

  show(): void {
    this.active = true;
    this.visible = true;
    this.t = 0;
  }

  hide(): void {
    this.active = false;
  }

  /** Pops in at full strength, holds 0.45 s, fades over 0.25 s (the strike lands ~0.2 s later). */
  update(dt: number, anchor: THREE.Vector3, camera: THREE.Camera): void {
    if (!this.visible) return;
    this.t += dt;
    if (this.active) this.a = this.t < 0.45 ? 1 : Math.max(0, 1 - (this.t - 0.45) / 0.25);
    else this.a = Math.max(0, this.a - dt * 6);
    const s = 1 + 0.18 * Math.exp(-this.t / 0.05);
    _proj.copy(anchor).project(camera);
    const x = (_proj.x * 0.5 + 0.5) * window.innerWidth;
    const y = (-_proj.y * 0.5 + 0.5) * window.innerHeight;
    const behind = _proj.z > 1;
    this.el.style.opacity = behind ? "0" : this.a.toFixed(3);
    this.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -50%) scale(${s.toFixed(3)})`;
    if (this.a <= 0) {
      this.visible = false;
      this.active = false;
      this.el.style.opacity = "0";
    }
  }
}

/** Pulsing red dot on the staggered boss: "strike now". */
export class DeathDot {
  readonly mesh: THREE.Mesh;
  private readonly mat: THREE.ShaderMaterial;
  private t = 0;
  active = false;

  constructor() {
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uT: { value: 0 }, uA: { value: 0 } },
      vertexShader: BB_VERT,
      fragmentShader: /* glsl */ `
        uniform float uT; uniform float uA; varying vec2 vUv;
        void main() {
          vec2 p = (vUv - 0.5) * 2.0;
          float r = length(p);
          // A hard blood-red bead with a hot heart and a tight breathing glow (no flat disc).
          float core = 1.0 - smoothstep(0.1, 0.14, r);
          float heart = exp(-r * r * 400.0);
          float glow = exp(-r * 11.0) * (0.65 + 0.35 * sin(uT * 7.0));
          float dr = (r - fract(uT * 0.8) * 0.8) * 26.0;
          float ring = exp(-dr * dr) * (1.0 - fract(uT * 0.8)) * 0.6;
          vec3 col = vec3(7.0, 0.22, 0.1) * core + vec3(9.0, 3.0, 1.6) * heart + vec3(2.2, 0.06, 0.03) * glow + vec3(2.0, 0.08, 0.04) * ring;
          gl_FragColor = vec4(col * uA, 1.0);
        }`,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 9;
    this.mesh.visible = false;
    this.mesh.scale.setScalar(0.9);
  }

  update(dt: number, anchor: THREE.Vector3): void {
    this.t += dt;
    this.mesh.position.copy(anchor);
    const cur = this.mat.uniforms.uA.value as number;
    const a = this.active ? Math.min(1, cur + dt * 4) : Math.max(0, cur - dt * 3);
    this.mat.uniforms.uA.value = a;
    this.mat.uniforms.uT.value = this.t;
    this.mesh.visible = a > 0.001;
  }
}
