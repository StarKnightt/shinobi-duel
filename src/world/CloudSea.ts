/**
 * Everything below the rooftop: a moonlit sea of cloud that the castle rises out of, a thinner
 * layer of wisps drifting just under the eaves (parallax), and — through the breaks in the
 * cloud, a long way down — the warm lights of the castle town. The drop is the point: every
 * shot that looks past the eaves should say "you are very high up and it is a long way to fall".
 *
 * One opaque plane (clouds + the view down through the gaps) and one transparent wisp layer.
 * Lit analytically: a directional derivative of the cloud height toward the moon gives lit
 * tops and dark undersides without a normal pass.
 */
import * as THREE from "three";
import { SUN_DIR } from "./materials";

export const CLOUD_Y = -20;
const TOWN_Y = -190;

const NOISE = /* glsl */ `
float csH(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float csN(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(csH(i), csH(i + vec2(1, 0)), u.x), mix(csH(i + vec2(0, 1)), csH(i + vec2(1, 1)), u.x), u.y);
}
float csFbm(vec2 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 5; i++) { s += a * csN(p); p = mat2(1.6, 1.2, -1.2, 1.6) * p + 7.3; a *= 0.5; }
  return s;
}`;

/** Horizon haze the cloud sea and the wisps fade into (matches the sky's horizon). */
export const HORIZON_GLSL = /* glsl */ `
vec3 nightHorizon(vec3 d, vec3 moon) {
  vec2 hz = normalize(d.xz + 1e-5);
  float toward = max(dot(hz, normalize(moon.xz)), 0.0);
  vec3 c = vec3(0.016, 0.024, 0.042);
  c += vec3(0.05, 0.068, 0.1) * pow(toward, 3.0);
  c += vec3(0.12, 0.14, 0.17) * pow(toward, 24.0);
  return c;
}`;

const SEA_VERT = /* glsl */ `
varying vec3 vW;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const SEA_FRAG = /* glsl */ `
uniform float uTime;
uniform vec3 uMoon;
uniform vec2 uWind;
uniform float uBlood;
varying vec3 vW;
${NOISE}
${HORIZON_GLSL}
float cloudH(vec2 p) {
  vec2 q = p * 0.0055 + uWind * uTime;
  vec2 w = vec2(csFbm(q * 0.6 + 3.0), csFbm(q * 0.6 - 5.0));
  float n = csFbm(q + w * 1.6);
  // Billowed: puff the mid-tones, open dark breaks in the low ones.
  return smoothstep(0.32, 0.72, n);
}
// Lights of the castle town far below: a hashed grid masked into streets and quarters.
vec3 town(vec2 p, float dist) {
  float quarter = smoothstep(0.42, 0.62, csFbm(p * 0.0022 + 11.0));
  vec2 cell = floor(p / 7.0);
  vec2 f = fract(p / 7.0) - 0.5;
  float h = csH(cell);
  float h2 = csH(cell + 17.3);
  vec2 o = (vec2(h, h2) - 0.5) * 0.6;
  float street = smoothstep(0.65, 0.95, max(abs(sin(p.x * 0.019 + csN(p * 0.004) * 3.0)), abs(sin(p.y * 0.023 + 1.3))));
  float on = step(0.72 - street * 0.25, h) * quarter;
  // Point size grows with distance a little so far lights don't shimmer away to nothing.
  float r = length(f - o) * (7.0 / (0.55 + dist * 0.0009));
  float pt = exp(-r * r * 9.0) * on;
  float flick = 0.8 + 0.2 * sin(uTime * (2.0 + h * 5.0) + h2 * 40.0);
  vec3 warm = mix(vec3(1.0, 0.42, 0.12), vec3(1.0, 0.7, 0.36), h2);
  // Glow of the whole quarter bleeding up into the haze.
  return warm * (pt * 3.2 * flick + quarter * 0.035);
}
void main() {
  vec3 d = vW - cameraPosition;
  float dist = length(d);
  vec3 v = d / dist;
  vec2 p = vW.xz;
  float h = cloudH(p);
  // Directional derivative toward the moon: tops facing it are silver, the lee sides fall into blue shadow.
  vec2 md = normalize(uMoon.xz);
  float hm = cloudH(p + md * 16.0);
  float lit = clamp(0.5 + (hm - h) * 4.0, 0.0, 1.0);
  float toMoon = pow(max(dot(normalize(v.xz), md), 0.0), 6.0);
  vec3 shadowC = vec3(0.012, 0.018, 0.034);
  vec3 litC = vec3(0.16, 0.19, 0.26);
  vec3 cloud = mix(shadowC, litC, lit * (0.35 + 0.65 * h));
  // Silver lining on thin cloud between the viewer and the moon.
  cloud += vec3(0.32, 0.36, 0.42) * toMoon * h * (1.0 - h) * 2.6;
  cloud += vec3(0.05, 0.06, 0.08) * toMoon * h;
  // Through the breaks: the drop. Re-trace the view ray to the town plane far below.
  float t = (${TOWN_Y.toFixed(1)} - cameraPosition.y) / min(v.y, -0.02);
  vec3 tp = cameraPosition + v * t;
  vec3 below = vec3(0.004, 0.006, 0.012) + town(tp.xz, t) * exp(-t * 0.0011);
  // Faint glow on the cloud undersides from the town.
  float gap = 1.0 - smoothstep(0.02, 0.32, h);
  vec3 c = mix(cloud, below, gap);
  c += vec3(0.05, 0.022, 0.008) * smoothstep(0.0, 0.4, h) * (1.0 - smoothstep(0.4, 0.8, h)) * smoothstep(0.42, 0.62, csFbm(p * 0.0022 + 11.0)) * 0.5;
  // Aerial perspective into the night horizon.
  float haze = 1.0 - exp(-dist * 0.0013);
  c = mix(c, nightHorizon(v, uMoon), haze);
  // Finisher: the world drains toward ink and blood.
  c = mix(c, vec3(dot(c, vec3(0.3, 0.5, 0.2))) * vec3(1.2, 0.5, 0.45), uBlood * 0.6);
  gl_FragColor = vec4(c, 1.0);
}`;

const WISP_FRAG = /* glsl */ `
uniform float uTime;
uniform vec3 uMoon;
uniform vec2 uWind;
uniform float uAlpha;
uniform float uScale;
uniform float uInner;
varying vec3 vW;
${NOISE}
${HORIZON_GLSL}
void main() {
  vec2 p = vW.xz * uScale + uWind * uTime * 3.0;
  float n = csFbm(p + vec2(csFbm(p * 0.7 + uTime * 0.02), 0.0) * 1.3);
  float r = length(vW.xz);
  // Never over the fighting floor; thickest a few tens of metres out.
  float a = smoothstep(0.42, 0.78, n) * uAlpha * smoothstep(uInner, uInner * 1.7, r);
  vec3 d = normalize(vW - cameraPosition);
  float toMoon = pow(max(dot(normalize(d.xz), normalize(uMoon.xz)), 0.0), 5.0);
  vec3 c = mix(vec3(0.05, 0.065, 0.1), vec3(0.2, 0.23, 0.29), toMoon) * (0.7 + n * 0.5);
  float dist = length(vW - cameraPosition);
  c = mix(c, nightHorizon(d, uMoon), 1.0 - exp(-dist * 0.003));
  gl_FragColor = vec4(c, a);
}`;

export class CloudSea {
  readonly group = new THREE.Group();
  private readonly mats: THREE.ShaderMaterial[] = [];
  private readonly sea: THREE.ShaderMaterial;

  constructor() {
    const wind = new THREE.Vector2(-0.006, 0.0025);
    this.sea = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uMoon: { value: SUN_DIR.clone() },
        uWind: { value: wind },
        uBlood: { value: 0 },
      },
      vertexShader: SEA_VERT,
      fragmentShader: SEA_FRAG,
      fog: false,
    });
    const sea = new THREE.Mesh(new THREE.PlaneGeometry(4200, 4200, 1, 1), this.sea);
    sea.rotation.x = -Math.PI / 2;
    sea.position.y = CLOUD_Y;
    sea.frustumCulled = false;
    sea.renderOrder = -5;
    this.group.add(sea);
    this.mats.push(this.sea);

    const wisp = (y: number, size: number, alpha: number, scale: number, inner: number) => {
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          uTime: { value: 0 },
          uMoon: { value: SUN_DIR.clone() },
          uWind: { value: new THREE.Vector2(-0.02, 0.009) },
          uAlpha: { value: alpha },
          uScale: { value: scale },
          uInner: { value: inner },
        },
        vertexShader: SEA_VERT,
        fragmentShader: WISP_FRAG,
        transparent: true,
        depthWrite: false,
        fog: false,
      });
      const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), mat);
      m.rotation.x = -Math.PI / 2;
      m.position.y = y;
      m.renderOrder = 2;
      m.frustumCulled = false;
      this.group.add(m);
      this.mats.push(mat);
    };
    // Rags of cloud tearing past below the eaves, and a higher, thinner sheet farther out.
    wisp(-15, 700, 0.75, 0.03, 22);
    wisp(-8, 420, 0.4, 0.05, 26);
  }

  set blood(v: number) {
    this.sea.uniforms.uBlood.value = v;
  }

  update(t: number): void {
    for (const m of this.mats) m.uniforms.uTime.value = t;
  }
}
