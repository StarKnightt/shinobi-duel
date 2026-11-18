/**
 * Falling snow: GPU-animated points in a box that wraps around the camera, driven hard by the
 * blizzard. Flakes toward the moon forward-scatter into silver glints, the rest stay steel blue.
 */
import * as THREE from "three";
import { rng } from "../core/math";
import { SUN_DIR } from "../world/materials";

export class Snow {
  readonly points: THREE.Points;
  private readonly mat: THREE.ShaderMaterial;

  constructor(count = 9000) {
    const R = rng(42);
    const pos = new Float32Array(count * 3);
    const seed = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = R() * 60;
      pos[i * 3 + 1] = R() * 26;
      pos[i * 3 + 2] = R() * 60;
      seed[i] = R();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uCam: { value: new THREE.Vector3() },
        uWind: { value: new THREE.Vector3(-1.4, 0, 0.6) },
        uSun: { value: SUN_DIR.clone() },
        uScale: { value: 600 },
      },
      vertexShader: /* glsl */ `
        attribute float aSeed;
        uniform float uTime; uniform vec3 uCam; uniform vec3 uWind; uniform float uScale; uniform vec3 uSun;
        varying float vA; varying float vGlint;
        void main() {
          vec3 box = vec3(60.0, 26.0, 60.0);
          vec3 p = position;
          float fall = 0.7 + aSeed * 0.9;
          p += uWind * uTime * (0.6 + aSeed * 0.6);
          p.y -= uTime * fall;
          p.x += sin(uTime * (0.8 + aSeed) + aSeed * 40.0) * 0.4;
          p.z += cos(uTime * (0.6 + aSeed * 0.7) + aSeed * 23.0) * 0.4;
          vec3 origin = uCam - box * 0.5;
          origin.y = uCam.y - 10.0;
          p = mod(p - origin, box) + origin;
          vec4 mv = viewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          float size = 0.028 + aSeed * 0.035;
          gl_PointSize = clamp(size * uScale / -mv.z, 1.0, 14.0);
          vec3 d = normalize(p - cameraPosition);
          vGlint = pow(max(dot(d, uSun), 0.0), 5.0);
          float dist = -mv.z;
          vA = smoothstep(0.3, 1.2, dist) * (1.0 - smoothstep(22.0, 32.0, dist));
        }`,
      fragmentShader: /* glsl */ `
        varying float vA; varying float vGlint;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float d = length(c);
          float a = (1.0 - smoothstep(0.1, 0.5, d)) * vA;
          vec3 col = mix(vec3(0.36, 0.42, 0.56), vec3(2.6, 2.8, 3.2), vGlint);
          gl_FragColor = vec4(col * a, a * 0.9);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 6;
  }

  update(t: number, cam: THREE.Vector3, wind: number, viewportH: number): void {
    this.mat.uniforms.uTime.value = t;
    this.mat.uniforms.uCam.value.copy(cam);
    this.mat.uniforms.uWind.value.set(-2.6 - wind * 4.2, 0, 1.2 + wind * 1.9);
    this.mat.uniforms.uScale.value = viewportH * 0.9;
  }
}
