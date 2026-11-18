/**
 * The storm that makes the roof feel exposed:
 *   streaks  wind-driven snow travelling fast enough to smear into short lines (instanced quads
 *            in a box that wraps around the camera, stretched along the wind in screen space)
 *   drift    spindrift: sheets of powder skating low across the tiles and round the fighters'
 *            ankles, two scrolling noise layers just above the floor
 * Both brighten toward the moon (forward scattering) and swell with the gusts.
 */
import * as THREE from "three";
import { rng } from "../core/math";
import { SUN_DIR } from "../world/materials";

const STREAK_VERT = /* glsl */ `
attribute vec4 aSeed;
uniform float uTime;
uniform vec3 uCam;
uniform vec3 uWind;
uniform float uGust;
uniform vec3 uMoon;
varying vec2 vC;
varying float vA;
varying float vGlint;
void main() {
  vec3 box = vec3(36.0, 14.0, 36.0);
  float sp = 0.75 + aSeed.w * 0.6;
  vec3 vel = uWind * sp + vec3(0.0, -1.6 - aSeed.w, 0.0);
  vec3 p = aSeed.xyz * box + vel * uTime;
  vec3 origin = uCam - box * 0.5;
  origin.y = uCam.y - 5.0;
  p = mod(p - origin, box) + origin;
  vec4 vp = viewMatrix * vec4(p, 1.0);
  vec2 ax = (viewMatrix * vec4(vel, 0.0)).xy;
  float l = length(ax);
  ax = l > 1e-4 ? ax / l : vec2(0.0, 1.0);
  vec2 side = vec2(ax.y, -ax.x);
  float len = (0.03 + l * 0.045) * (0.6 + uGust * 0.8);
  float wid = 0.008 + aSeed.w * 0.007;
  vp.xy += ax * position.y * len + side * position.x * wid;
  vC = position.xy;
  float dist = -vp.z;
  vA = smoothstep(0.8, 2.5, dist) * (1.0 - smoothstep(12.0, 18.0, dist)) * (0.35 + uGust * 0.65);
  vec3 d = normalize(p - cameraPosition);
  vGlint = pow(max(dot(d, uMoon), 0.0), 8.0);
  gl_Position = projectionMatrix * vp;
}`;

const STREAK_FRAG = /* glsl */ `
varying vec2 vC;
varying float vA;
varying float vGlint;
void main() {
  float w = 1.0 - abs(vC.x);
  float l = 1.0 - abs(vC.y);
  float a = w * w * l * vA;
  vec3 c = mix(vec3(0.42, 0.48, 0.6), vec3(1.6, 1.7, 1.9), vGlint);
  gl_FragColor = vec4(c * a, a);
}`;

const DRIFT_VERT = /* glsl */ `
varying vec3 vW;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const DRIFT_FRAG = /* glsl */ `
uniform float uTime;
uniform vec2 uFlow;
uniform float uGust;
uniform float uAlpha;
uniform float uScale;
uniform vec3 uMoon;
varying vec3 vW;
float dH(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float dN(vec2 p) { vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(dH(i), dH(i + vec2(1, 0)), u.x), mix(dH(i + vec2(0, 1)), dH(i + vec2(1, 1)), u.x), u.y); }
float dF(vec2 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++) { s += a * dN(p); p = p * 2.07 + 3.1; a *= 0.5; } return s; }
void main() {
  // Stretch the noise along the wind so the powder reads as streaming ribbons.
  vec2 f = normalize(uFlow);
  vec2 q = vec2(dot(vW.xz, f) * 0.35, dot(vW.xz, vec2(-f.y, f.x)) * 1.6) * uScale;
  q.x -= uTime * length(uFlow) * 0.35 * uScale;
  float n = dF(q + vec2(dF(q * 0.5 + uTime * 0.2), 0.0));
  float a = smoothstep(0.45, 0.85, n) * uAlpha * (0.4 + uGust * 0.9);
  // Fade out at the eaves so the sheet never shows an edge.
  float r = max(abs(vW.x), abs(vW.z + 0.5));
  a *= 1.0 - smoothstep(10.5, 13.0, r);
  vec3 d = normalize(vW - cameraPosition);
  float g = pow(max(dot(d, uMoon), 0.0), 4.0);
  vec3 c = mix(vec3(0.26, 0.3, 0.4), vec3(0.85, 0.9, 1.0), g);
  gl_FragColor = vec4(c, a);
}`;

export class Blizzard {
  readonly group = new THREE.Group();
  private readonly streak: THREE.ShaderMaterial;
  private readonly drifts: THREE.ShaderMaterial[] = [];

  constructor(count = 2200) {
    const R = rng(808);
    const seeds = new Float32Array(count * 4);
    for (let i = 0; i < seeds.length; i++) seeds[i] = R();
    const quad = new THREE.BufferGeometry();
    quad.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    quad.setIndex([0, 1, 2, 0, 2, 3]);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = quad.index;
    geo.setAttribute("position", quad.getAttribute("position"));
    geo.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seeds, 4));
    geo.instanceCount = count;
    this.streak = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uCam: { value: new THREE.Vector3() },
        uWind: { value: new THREE.Vector3(-9, 0, 4) },
        uGust: { value: 0.5 },
        uMoon: { value: SUN_DIR.clone() },
      },
      vertexShader: STREAK_VERT,
      fragmentShader: STREAK_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const streaks = new THREE.Mesh(geo, this.streak);
    streaks.frustumCulled = false;
    streaks.renderOrder = 6;
    this.group.add(streaks);

    const drift = (y: number, alpha: number, scale: number) => {
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          uTime: { value: 0 },
          uFlow: { value: new THREE.Vector2(-9, 4) },
          uGust: { value: 0.5 },
          uAlpha: { value: alpha },
          uScale: { value: scale },
          uMoon: { value: SUN_DIR.clone() },
        },
        vertexShader: DRIFT_VERT,
        fragmentShader: DRIFT_FRAG,
        transparent: true,
        depthWrite: false,
      });
      const m = new THREE.Mesh(new THREE.PlaneGeometry(28, 28), mat);
      m.rotation.x = -Math.PI / 2;
      m.position.set(0, y, -0.5);
      m.renderOrder = 3;
      this.group.add(m);
      this.drifts.push(mat);
    };
    drift(0.07, 0.42, 1.0);
    drift(0.22, 0.2, 0.7);
  }

  update(t: number, cam: THREE.Vector3, wind: THREE.Vector3, gust: number): void {
    const u = this.streak.uniforms;
    u.uTime.value = t;
    u.uCam.value.copy(cam);
    // Storm wind: the gameplay wind's direction, much stronger (it's visual only).
    u.uWind.value.set(-8.5 - gust * 6, 0, 3.6 + gust * 2.5);
    u.uGust.value = gust;
    for (const m of this.drifts) {
      m.uniforms.uTime.value = t;
      m.uniforms.uGust.value = gust;
      (m.uniforms.uFlow.value as THREE.Vector2).set(-7 - gust * 6, 3 + gust * 2.5);
    }
    void wind;
  }
}
