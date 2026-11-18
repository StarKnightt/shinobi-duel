/**
 * Post pipeline (pmndrs/postprocessing):
 *   scene (HDR half-float, MSAA) → N8AO contact shadows → deflect shockwave (a refractive ripple
 *   out of the clash point) → moonbeams + mipmap bloom (sparks, lanterns, moon) → grade:
 *   exposure, hue-preserving filmic curve, then in display space a teal-steel shadow tint and a
 *   warm gain kept for the brightest things (lanterns, sparks: the only heat in the night),
 *   luminance-keyed saturation, a hard S-curve, fine grain, hit flash, finisher bleed,
 *   cinematic bars → chromatic aberration (pulses on hits) + vignette.
 */
import * as THREE from "three";
import {
  BlendFunction,
  BloomEffect,
  ChromaticAberrationEffect,
  Effect,
  EffectComposer,
  EffectPass,
  GodRaysEffect,
  KernelSize,
  RenderPass,
  VignetteEffect,
} from "postprocessing";
import { N8AOPostPass } from "n8ao";

/** Tuned grade (see TASKS.md "Lighting pass"). */
export const GRADE = {
  exposure: 0.92,
  /** Saturation of shadows / mid-tones and of bright highlights (sparks, lanterns, moon). */
  satLow: 0.72,
  satHigh: 1.3,
  /** Lift added to the shadows (display space, cold) and gain on the highlights (warm). */
  lift: [0.0, 0.006, 0.016],
  gain: [1.05, 1.0, 0.95],
  contrast: 0.5,
  grain: 0.018,
};

const GRADE_FRAG = /* glsl */ `
uniform float uExposure;
uniform float uSatLow;
uniform float uSatHigh;
uniform vec3 uLift;
uniform vec3 uGain;
uniform float uContrast;
uniform float uGrain;
uniform float uFlash;
uniform vec3 uFlashColor;
uniform float uDesat;
uniform float uBars;
uniform float uFade;
float gH(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float gN(vec2 p) { vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(gH(i), gH(i + vec2(1, 0)), u.x), mix(gH(i + vec2(0, 1)), gH(i + vec2(1, 1)), u.x), u.y); }
vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 c = max(inputColor.rgb * uExposure, 0.0);
  // Filmic shoulder; half of it applied on luminance so hot oranges stay orange (no yellow skew).
  float l0 = dot(c, vec3(0.2126, 0.7152, 0.0722));
  vec3 tm = aces(c);
  vec3 tl = c * (aces(vec3(l0)).x / max(l0, 1e-4));
  c = clamp(mix(tm, tl, 0.45), 0.0, 1.0);
  // Display space for the grade.
  c = pow(c, vec3(1.0 / 2.2));
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  // Low-saturation dusk, but sparks / lanterns / the sun keep their heat.
  c = mix(vec3(l), c, mix(uSatLow, uSatHigh, smoothstep(0.6, 0.95, l)));
  // Split tone: cold blue lift in the shadows, warm peach gain in the highlights.
  c = c * mix(vec3(1.0), uGain, smoothstep(0.35, 1.0, l)) + uLift * (1.0 - smoothstep(0.0, 0.5, l));
  // Teal-steel shadows and mid-tones: warmth lives only in the lanterns and the sparks.
  c *= mix(vec3(0.86, 0.98, 1.1), vec3(1.0), smoothstep(0.2, 0.7, l));
  // Gentle S-curve around mid grey.
  c = clamp(c, 0.0, 1.0);
  c = mix(c, c * c * (3.0 - 2.0 * c), uContrast);
  // Finisher: bleed colour out to ink, but let pure reds (the moon, the ink) burn through.
  float gl = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float redness = smoothstep(0.08, 0.35, c.r - max(c.g, c.b));
  c = mix(c, mix(vec3(gl * 0.95, gl * 0.93, gl * 0.98), c * vec3(1.15, 0.9, 0.9), redness), uDesat);
  c = mix(c, uFlashColor, uFlash);
  // Paper / brush grain (static, screen space): a washi texture instead of video noise.
  vec2 fc = gl_FragCoord.xy;
  float paper = gN(fc * 0.35) * 0.5 + gN(fc * 0.09 + 7.0) * 0.5;
  float fib = gN(vec2(fc.x * 0.02, fc.y * 0.6));
  c *= 1.0 + (paper - 0.5) * uGrain + (fib - 0.5) * uGrain * 0.35;
  c += (gH(fc + fract(time) * 91.0) - 0.5) * 0.012;
  float bar = uBars * 0.11;
  c *= step(bar, uv.y) * step(uv.y, 1.0 - bar);
  c *= 1.0 - uFade;
  outputColor = vec4(pow(max(c, 0.0), vec3(2.2)), inputColor.a);
}
`;

/** A refractive ring blown out of the clash point: the deflect's "air crack". */
const SHOCK_FRAG = /* glsl */ `
uniform vec2 uCenter;
uniform float uT;
uniform float uAmp;
uniform float uSize;
void mainUv(inout vec2 uv) {
  if (uT >= 1.0) return;
  vec2 asp = vec2(aspect, 1.0);
  vec2 d = (uv - uCenter) * asp;
  float r = length(d);
  float rad = uSize * (1.0 - pow(1.0 - uT, 3.0));
  float w = 0.035 + uSize * 0.12;
  float x = (r - rad) / w;
  float ring = exp(-x * x * 2.5) * x;
  uv -= (d / max(r, 1e-4)) / asp * ring * uAmp * (1.0 - uT) * (1.0 - uT);
}`;

const _sp = new THREE.Vector3();
const _hp = new THREE.Vector3();

/**
 * Phase-2 rage: heat shimmer round the general. A rising, wobbling refraction inside a tall
 * ellipse over his body (screen space), strongest at its heart, gone at its rim.
 */
const HEAT_FRAG = /* glsl */ `
uniform vec2 uCenter;
uniform vec2 uSize;
uniform float uK;
uniform float uTime;
float hh(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float hn(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hh(i), hh(i + vec2(1, 0)), f.x), mix(hh(i + vec2(0, 1)), hh(i + vec2(1, 1)), f.x), f.y);
}
void mainUv(inout vec2 uv) {
  if (uK <= 0.0) return;
  vec2 d = (uv - uCenter) * vec2(aspect, 1.0) / uSize;
  float m = 1.0 - smoothstep(0.35, 1.0, length(d));
  if (m <= 0.0) return;
  vec2 q = uv * vec2(aspect, 1.0) * 38.0 + vec2(0.0, -uTime * 2.6);
  vec2 o = vec2(hn(q) - 0.5, hn(q + 17.3) - 0.5);
  uv += o * 0.0045 * uK * m;
}`;

class ShockEffect extends Effect {
  constructor() {
    super("ShockEffect", SHOCK_FRAG, {
      uniforms: new Map<string, THREE.Uniform>([
        ["uCenter", new THREE.Uniform(new THREE.Vector2(0.5, 0.5))],
        ["uT", new THREE.Uniform(1)],
        ["uAmp", new THREE.Uniform(0.02)],
        ["uSize", new THREE.Uniform(0.2)],
      ]),
    });
  }
  u(name: string): THREE.Uniform {
    return this.uniforms.get(name)!;
  }
}

class HeatEffect extends Effect {
  constructor() {
    super("HeatEffect", HEAT_FRAG, {
      uniforms: new Map<string, THREE.Uniform>([
        ["uCenter", new THREE.Uniform(new THREE.Vector2(0.5, 0.5))],
        ["uSize", new THREE.Uniform(new THREE.Vector2(0.2, 0.35))],
        ["uK", new THREE.Uniform(0)],
        ["uTime", new THREE.Uniform(0)],
      ]),
    });
  }
  u(name: string): THREE.Uniform {
    return this.uniforms.get(name)!;
  }
}

class GradeEffect extends Effect {
  constructor() {
    super("GradeEffect", GRADE_FRAG, {
      uniforms: new Map<string, THREE.Uniform>([
        ["uExposure", new THREE.Uniform(GRADE.exposure)],
        ["uSatLow", new THREE.Uniform(GRADE.satLow)],
        ["uSatHigh", new THREE.Uniform(GRADE.satHigh)],
        ["uLift", new THREE.Uniform(new THREE.Vector3(...GRADE.lift))],
        ["uGain", new THREE.Uniform(new THREE.Vector3(...GRADE.gain))],
        ["uContrast", new THREE.Uniform(GRADE.contrast)],
        ["uGrain", new THREE.Uniform(GRADE.grain)],
        ["uFlash", new THREE.Uniform(0)],
        ["uFlashColor", new THREE.Uniform(new THREE.Color(1, 0.85, 0.6))],
        ["uDesat", new THREE.Uniform(0)],
        ["uBars", new THREE.Uniform(0)],
        ["uFade", new THREE.Uniform(0)],
      ]),
    });
  }
  u(name: string): THREE.Uniform {
    return this.uniforms.get(name)!;
  }
}

export class Post {
  private readonly composer: EffectComposer;
  readonly bloom: BloomEffect;
  private readonly grade: GradeEffect;
  private readonly ca: ChromaticAberrationEffect;
  private readonly vignette: VignetteEffect;
  private readonly ao: N8AOPostPass;
  private readonly shockFx = new ShockEffect();
  private readonly heatFx = new HeatEffect();
  private heatT = 0;
  private shockT = 1;
  private shockDur = 0.3;
  private readonly shockAt = new THREE.Vector3();

  /** Transient intensities, decayed each frame (real time). */
  flash = 0;
  aberration = 0;
  desat = 0;
  bars = 0;
  fade = 0;
  private flashColor = new THREE.Color(1, 0.85, 0.6);

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, sun?: THREE.Mesh) {
    this.camera = camera;
    this.composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType, multisampling: 4 });
    this.composer.addPass(new RenderPass(scene, camera));
    // Contact shadows: armour rows, cloth folds and feet on the tiles read as form, not plastic.
    this.ao = new N8AOPostPass(scene, camera, window.innerWidth, window.innerHeight);
    this.ao.setQualityMode("Medium");
    this.ao.configuration.aoRadius = 0.6;
    this.ao.configuration.distanceFalloff = 0.4;
    this.ao.configuration.intensity = 3.8;
    // Near-black blue occlusion: deep night contact shadows.
    this.ao.configuration.color = new THREE.Color(0.01, 0.014, 0.03);
    this.ao.configuration.gammaCorrection = false;
    this.ao.configuration.halfRes = true;
    this.composer.addPass(this.ao);
    this.composer.addPass(new EffectPass(camera, this.shockFx, this.heatFx));

    this.bloom = new BloomEffect({
      mipmapBlur: true,
      luminanceThreshold: 1.0,
      luminanceSmoothing: 0.3,
      intensity: 1.15,
      radius: 0.78,
      levels: 8,
    });
    this.grade = new GradeEffect();
    const rays = sun
      ? [
          new GodRaysEffect(camera, sun, {
            density: 0.9,
            decay: 0.93,
            weight: 0.14,
            exposure: 0.16,
            samples: 60,
            clampMax: 1.0,
            kernelSize: KernelSize.SMALL,
            blur: true,
          }),
        ]
      : [];
    this.composer.addPass(new EffectPass(camera, ...rays, this.bloom, this.grade));

    this.ca = new ChromaticAberrationEffect({
      offset: new THREE.Vector2(0, 0),
      radialModulation: true,
      modulationOffset: 0.2,
    });
    this.vignette = new VignetteEffect({ offset: 0.28, darkness: 0.62 });
    this.vignette.blendMode.blendFunction = BlendFunction.NORMAL;
    this.composer.addPass(new EffectPass(camera, this.ca, this.vignette));
  }

  hitFlash(amount: number, color?: THREE.ColorRepresentation): void {
    this.flash = Math.max(this.flash, amount);
    if (color !== undefined) this.flashColor.set(color);
    else this.flashColor.setRGB(1, 0.85, 0.6);
  }

  /** Deflect shockwave from a world point (size in screen heights, amp = refraction strength). */
  shock(at: THREE.Vector3, size = 0.22, amp = 0.025, dur = 0.32): void {
    this.shockAt.copy(at);
    this.shockT = 0;
    this.shockDur = dur;
    this.shockFx.u("uSize").value = size;
    this.shockFx.u("uAmp").value = amp;
  }

  private camera: THREE.Camera | null = null;

  /**
   * Heat shimmer over a body: `at` is its centre (world), `height` its height in metres, `k` 0..1.
   * Call every frame while it should show (k = 0 turns it off).
   */
  heat(at: THREE.Vector3, height: number, k: number, dt: number): void {
    const u = this.heatFx;
    this.heatT += dt;
    u.u("uTime").value = this.heatT;
    if (k <= 0 || !this.camera) {
      u.u("uK").value = 0;
      return;
    }
    const p = _hp.copy(at).project(this.camera);
    if (p.z >= 1) {
      u.u("uK").value = 0;
      return;
    }
    const cam = this.camera as THREE.PerspectiveCamera;
    const dist = Math.max(0.5, cam.position.distanceTo(at));
    const sh = (height / (2 * dist * Math.tan(THREE.MathUtils.degToRad((cam.fov ?? 50) / 2)))) * 1.0;
    (u.u("uCenter").value as THREE.Vector2).set(p.x * 0.5 + 0.5, p.y * 0.5 + 0.5);
    (u.u("uSize").value as THREE.Vector2).set(sh * 0.42, sh * 0.62);
    u.u("uK").value = k;
  }

  kickAberration(amount: number): void {
    this.aberration = Math.max(this.aberration, amount);
  }

  render(dt: number): void {
    this.flash *= Math.exp(-dt / 0.06);
    this.aberration *= Math.exp(-dt / 0.12);
    const g = this.grade;
    g.u("uFlash").value = this.flash;
    (g.u("uFlashColor").value as THREE.Color).copy(this.flashColor);
    g.u("uDesat").value = this.desat;
    g.u("uBars").value = this.bars;
    g.u("uFade").value = this.fade;
    const a = 0.0001 + this.aberration * 0.0012;
    this.ca.offset.set(a, a * 0.6);
    this.vignette.darkness = 0.62 + this.desat * 0.25;
    if (this.shockT < 1 && this.camera) {
      this.shockT = Math.min(1, this.shockT + dt / this.shockDur);
      const p = _sp.copy(this.shockAt).project(this.camera);
      (this.shockFx.u("uCenter").value as THREE.Vector2).set(p.x * 0.5 + 0.5, p.y * 0.5 + 0.5);
      this.shockFx.u("uT").value = p.z < 1 ? this.shockT : 1;
    } else this.shockFx.u("uT").value = 1;
    this.composer.render(dt);
  }

  setSize(w: number, h: number): void {
    this.composer.setSize(w, h);
    this.ao.setSize(w, h);
  }
}
