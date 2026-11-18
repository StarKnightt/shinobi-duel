/**
 * The one arena: a castle rooftop at dusk.
 *
 * Built in Blender (tools/blender/build_arena.py) from Poly Haven CC0 textures and shipped as
 * public/assets/arena.glb (WebP textures, meshopt geometry, baked AO):
 *   fighting floor  26 m square of dark clay round tiles with snow in the channels
 *   ridge beam      raised ridge + onigawara end tiles along the far (-z) edge
 *   eaves           upturned skirts on the other three edges, the building dropping away below
 *   keep            five-tier keep (each tier ~0.82x the one below), curved roofs with snow slabs
 *   compound        halls, turrets and walls on stone bases stepping down, snowy pines
 *   lanterns        paper lanterns on posts (nodes LanternHang_NN, "_L" = carries a point light)
 * In code: the night — a blizzard under a huge low moon — sky, storm clouds and stars, ridged
 * peaks breaking out of a sea of cloud with the castle town glimmering far below (Surround /
 * CloudSea), the war banners, the moonlight rig, and the lantern swing / flicker.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { rng } from "../core/math";
import { Banners } from "./Banners";
import { CLOUD_Y } from "./CloudSea";
import { canvasTexture, LIGHT_DIR, MOON_R, SUN_DIR, snowify, type SnowOpts } from "./materials";
import { makeSnowField } from "./SnowField";
import { Surround } from "./Surround";

export const ARENA_HALF = 11.2;
export const RIDGE_Z = -13.2;

const ASSETS = `${import.meta.env.BASE_URL}assets/`;

const SKY_GLSL = /* glsl */ `
uniform vec3 uSun;
uniform float uTime;
uniform float uBlood;
float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float h31(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
float n2(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y);
}
float fbm(vec2 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++) { s += a * n2(p); p *= 2.03; a *= 0.5; } return s; }
// Night palette (scene-linear): near-black indigo zenith, steel-blue horizon that brightens into
// a cold silver band under the moon.
vec3 horizonCol(vec3 d) {
  vec2 hz = normalize(d.xz + 1e-5);
  float toward = max(dot(hz, normalize(uSun.xz)), 0.0);
  vec3 c = vec3(0.016, 0.024, 0.042);
  c += vec3(0.05, 0.068, 0.1) * pow(toward, 3.0);
  c += vec3(0.12, 0.14, 0.17) * pow(toward, 24.0);
  return c;
}
vec3 moonCol() { return mix(vec3(1.0, 1.0, 1.0), vec3(1.0, 0.1, 0.06), uBlood); }
vec3 skyCol(vec3 d, bool clouds) {
  float y = d.y;
  float s = max(dot(d, uSun), 0.0);
  vec3 hor = horizonCol(d);
  vec3 c = mix(hor, vec3(0.0025, 0.0035, 0.009), smoothstep(0.0, 0.6, y));
  c = mix(c, hor * 0.85, 1.0 - smoothstep(-0.12, 0.0, y));
  vec3 mc = moonCol();
  // Halo: a tight bright corona, a wide cold glow, and a faint 22-degree ice ring (it's snowing).
  float ang = acos(clamp(s, -1.0, 1.0));
  vec3 halo = vec3(0.42, 0.5, 0.64) * exp(-max(ang - ${MOON_R.toFixed(4)}, 0.0) * 60.0) * 0.4
            + vec3(0.05, 0.065, 0.1) * pow(s, 16.0) + vec3(0.012, 0.016, 0.026) * pow(s, 3.0);
  float ring = exp(-pow((ang - 0.384) * 34.0, 2.0)) * 0.035 * smoothstep(0.0, 0.08, y);
  c += (halo + vec3(0.9, 0.95, 1.0) * ring) * mc;
  // Stars: sparse, cold, washed out near the moon and the horizon.
  if (y > 0.0) {
    vec3 sp = d * 380.0;
    vec3 cell = floor(sp);
    float h = h31(cell);
    vec3 f = fract(sp) - 0.5 - (vec3(h31(cell + 3.1), h31(cell + 7.7), h31(cell + 1.3)) - 0.5) * 0.6;
    float st = step(0.9965, h) * exp(-dot(f, f) * 38.0) * (0.5 + 2.5 * pow(h31(cell + 9.0), 6.0));
    c += vec3(0.75, 0.85, 1.0) * st * 0.6 * smoothstep(0.04, 0.35, y) * (1.0 - pow(s, 30.0));
  }
  // The disc: crisp edge, limb darkening, maria and craters.
  vec3 mu = normalize(cross(uSun, vec3(0.0, 1.0, 0.0)));
  vec3 mv = cross(mu, uSun);
  vec2 mp = vec2(dot(d, mu), dot(d, mv)) / ${MOON_R.toFixed(4)};
  float mr = length(mp);
  float disk = (1.0 - smoothstep(0.985, 1.0, mr)) * step(0.0, s);
  if (disk > 0.0) {
    float maria = smoothstep(0.42, 0.68, fbm(mp * 1.6 + 2.0)) * 0.42 + smoothstep(0.5, 0.75, fbm(mp * 4.2 - 3.0)) * 0.18;
    float crater = smoothstep(0.62, 0.8, fbm(mp * 11.0 + 9.0)) * 0.12;
    float limb = pow(max(1.0 - mr * mr, 0.0), 0.25);
    vec3 surf = vec3(1.15, 1.2, 1.3) * (1.0 - maria * 1.3 - crater) * (0.62 + 0.38 * limb);
    c = mix(c, surf * mc, disk);
  }
  if (clouds) {
    // Storm cloud: a ragged deck tearing across the sky with the wind, its edges silvered where
    // they pass in front of the moon; a low dark bank lies along the horizon.
    float glow = pow(s, 14.0);
    if (y > -0.02) {
      vec2 q = d.xz / (y + 0.09);
      vec2 w = vec2(uTime * 0.028, -uTime * 0.012);
      float cl = fbm(q * vec2(0.55, 0.9) + w) * fbm(q * vec2(1.4, 2.1) - w * 1.7 + 3.0);
      cl = smoothstep(0.2, 0.5, cl) * smoothstep(-0.01, 0.06, y) * (1.0 - smoothstep(0.55, 0.9, y));
      // Keep the moon itself clear: the cloud parts round it (a hole in the deck).
      cl *= smoothstep(0.1, 0.32, ang);
      vec3 cc = mix(vec3(0.005, 0.007, 0.013), vec3(0.04, 0.05, 0.075), pow(s, 6.0));
      c = mix(c, cc, cl * 0.92);
      c += vec3(0.55, 0.62, 0.78) * glow * cl * (1.0 - cl) * 3.0 * mc;
    }
    float bank = (1.0 - smoothstep(-0.01, 0.05, y)) * smoothstep(0.35, 0.6, fbm(vec2(atan(d.x, d.z) * 6.0, y * 30.0)));
    c = mix(c, hor * 0.7, bank * 0.6);
  }
  return c;
}
`;

function makeSky(): THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial> {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uSun: { value: SUN_DIR.clone() },
      uTime: { value: 0 },
      uBlood: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww;
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vDir;
      ${SKY_GLSL}
      void main() { gl_FragColor = vec4(skyCol(normalize(vDir), true), 1.0); }`,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
  const m = new THREE.Mesh(new THREE.SphereGeometry(1500, 48, 24), mat);
  m.renderOrder = -10;
  m.frustumCulled = false;
  return m;
}

/**
 * Three ranges of ridged peaks breaking out of the cloud sea. Each is a ring of columns (bottom
 * under the clouds, top on the ridge line) with a per-column moonlight term from the ridge's
 * slope, so faces turned to the moon are snow-bright and the lee faces fall into blue shadow; the
 * ranges between the camera and the moon are silhouettes with a silver ridge line instead.
 */
function makeMountains(): THREE.Group {
  const g = new THREE.Group();
  const layers = [
    { r: 1150, h: 170, base: 30, dark: [0.012, 0.016, 0.03], haze: 0.7, seed: 3, sharp: 1.6 },
    { r: 700, h: 105, base: 0, dark: [0.008, 0.011, 0.022], haze: 0.5, seed: 11, sharp: 2.0 },
    { r: 380, h: 44, base: -14, dark: [0.006, 0.008, 0.016], haze: 0.3, seed: 29, sharp: 2.4 },
  ];
  // A notch in every range where the moon hangs, so the disc sits in a saddle between peaks.
  const moonAz = Math.atan2(SUN_DIR.x, SUN_DIR.z);
  const L = new THREE.Vector2(LIGHT_DIR.x, LIGHT_DIR.z).normalize();
  for (const Ly of layers) {
    const N = 900;
    const R = rng(Ly.seed);
    const ph = Array.from({ length: 8 }, () => R() * 6.283);
    const height = (a: number) => {
      // Ridged octaves: 1 - |sin| makes knife-edge summits, raised to a power for steep flanks.
      let h = 0;
      let amp = 1;
      let f = 3;
      for (let o = 0; o < 6; o++) {
        h += amp * Math.pow(1 - Math.abs(Math.sin(a * f + ph[o])), Ly.sharp);
        amp *= 0.5;
        f *= 2.17;
      }
      h = h / 1.9 + Math.sin(a * 2 + ph[6]) * 0.18 + Math.sin(a * 5 + ph[7]) * 0.1;
      const da = Math.atan2(Math.sin(a - moonAz), Math.cos(a - moonAz));
      const notch = 1 - 0.9 * Math.exp(-((da / 0.16) ** 2));
      return Ly.base + Math.max(0.05, h) * Ly.h * notch;
    };
    const pos: number[] = [];
    const lit: number[] = [];
    const top: number[] = [];
    const idx: number[] = [];
    const da = (Math.PI * 2) / N;
    for (let i = 0; i <= N; i++) {
      const a = i * da;
      const h = height(a);
      const slope = (height(a + da) - height(a - da)) / (2 * da * Ly.r);
      const x = Math.sin(a) * Ly.r;
      const z = Math.cos(a) * Ly.r;
      // Face normal (horizontal part): toward the viewer, tilted along the ridge by the slope.
      const nx = -Math.sin(a) - Math.cos(a) * slope * 2.2;
      const nz = -Math.cos(a) + Math.sin(a) * slope * 2.2;
      const nl = Math.hypot(nx, nz);
      const l = Math.max(0, (nx * L.x + nz * L.y) / nl);
      pos.push(x, CLOUD_Y - 30, z, x, h, z);
      lit.push(l, l);
      top.push(h, h);
    }
    for (let i = 0; i < N; i++) {
      const a = i * 2;
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("aLit", new THREE.Float32BufferAttribute(lit, 1));
    geo.setAttribute("aTop", new THREE.Float32BufferAttribute(top, 1));
    geo.setIndex(idx);
    const mat = new THREE.ShaderMaterial({
      uniforms: { uSun: { value: SUN_DIR.clone() }, uTime: { value: 0 }, uBlood: { value: 0 } },
      vertexShader: /* glsl */ `
        attribute float aLit; attribute float aTop;
        varying vec3 vW; varying float vLit; varying float vTop;
        void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vLit = aLit; vTop = aTop;
          gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: /* glsl */ `
        varying vec3 vW; varying float vLit; varying float vTop;
        ${SKY_GLSL}
        void main() {
          vec3 d = normalize(vW - cameraPosition);
          float toMoon = pow(max(dot(normalize(d.xz), normalize(uSun.xz)), 0.0), 3.0);
          // Snow streaked down the gullies (vertical noise, never a level snow line), lit only on
          // the faces turned to the moon; backlit ranges stay silhouettes.
          float ang = atan(vW.x, vW.z) * ${(Ly.r * 0.05).toFixed(1)};
          float gully = n2(vec2(ang, vW.y * 0.012)) * 0.6 + n2(vec2(ang * 3.7, vW.y * 0.03)) * 0.4;
          float depth = clamp((vTop - vW.y) / ${(Ly.h * 0.9).toFixed(1)}, 0.0, 1.0);
          float snow = smoothstep(0.35, 0.75, gully + (1.0 - depth) * 0.35 - depth * 0.3);
          vec3 rock = vec3(${Ly.dark.join(",")});
          vec3 snowLit = vec3(0.13, 0.16, 0.23) * vLit * (1.0 - toMoon);
          vec3 c = mix(rock, rock + snowLit, snow);
          // Backlit ranges right under the moon: a hair of silver along the ridge.
          float sharpMoon = pow(max(dot(normalize(d.xz), normalize(uSun.xz)), 0.0), 40.0);
          float edge = smoothstep(vTop - ${(Ly.h * 0.025).toFixed(1)}, vTop, vW.y);
          c += vec3(0.3, 0.34, 0.42) * edge * sharpMoon * moonCol();
          float haze = ${Ly.haze.toFixed(2)} * (0.75 + 0.25 * toMoon) + (1.0 - smoothstep(${(CLOUD_Y - 10).toFixed(1)}, ${(Ly.base + Ly.h * 0.4).toFixed(1)}, vW.y)) * 0.35;
          c = mix(c, horizonCol(d), clamp(haze, 0.0, 1.0));
          gl_FragColor = vec4(c, 1.0);
        }`,
      side: THREE.DoubleSide,
      fog: false,
    });
    const m = new THREE.Mesh(geo, mat);
    m.frustumCulled = false;
    m.renderOrder = -8;
    g.add(m);
  }
  return g;
}

/** Snow-shader settings per glTF material (the tuned look of the procedural arena). */
const SNOW_ALBEDO = new THREE.Color(0.6, 0.66, 0.78);
const SNOW: Record<string, SnowOpts> = {
  clay_tiles: { amount: 0.42, scale: 0.3, patch: 2.8, far: [16, 34], color: new THREE.Color(0.5, 0.56, 0.68), drift: 1, glitter: 1 },
  snow: { amount: 1, scale: 0.5, color: SNOW_ALBEDO, glitter: 1.2 },
  kawara: { amount: 0.3, scale: 0.35 },
  stone: { amount: 0.6, scale: 0.4 },
  wood_dark: { amount: 0.7 },
  lacquer: { amount: 0.9 },
  pine_needles: { amount: 0.6, scale: 0.9 },
};

export interface Lantern {
  group: THREE.Object3D;
  phase: number;
  light?: THREE.PointLight;
  mat: THREE.MeshStandardMaterial;
  /** Rest orientation; the swing is applied on top. */
  rest: THREE.Quaternion;
}

/** Lantern paper emissive (blooms above the 0.9 threshold) and the warm pool it throws. */
const LANTERN = { paper: 2.8, light: 20 };

/**
 * The fighters' rigid attachments (armour, helmet crest, hat, swords) hang off bones as plain
 * meshes, so they miss the USE_SKINNING rim. Everything under a skinned body's root gets the
 * CHAR_RIM define instead (one recompile when a character appears; character code untouched).
 */
function tagCharacterRim(scene: THREE.Scene): void {
  const roots = new Set<THREE.Object3D>();
  scene.traverse((o) => {
    if (!(o as THREE.SkinnedMesh).isSkinnedMesh) return;
    let r: THREE.Object3D = o;
    while (r.parent && r.parent !== scene) r = r.parent;
    roots.add(r);
  });
  for (const r of roots) {
    r.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || (m as THREE.SkinnedMesh).isSkinnedMesh) return;
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
        if (!(mat as THREE.MeshStandardMaterial).isMeshStandardMaterial) continue;
        mat.defines ??= {};
        if ("CHAR_RIM" in mat.defines) continue;
        mat.defines.CHAR_RIM = "";
        mat.needsUpdate = true;
      }
    });
  }
}

const _swing = new THREE.Quaternion();
const _euler = new THREE.Euler();

export class Arena {
  readonly group = new THREE.Group();
  readonly sun: THREE.DirectionalLight;
  readonly lanterns: Lantern[] = [];
  readonly surround: Surround;
  readonly banners = new Banners();
  /** True once arena.glb is in the scene. */
  loaded = false;
  private readonly sky: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  private readonly mountains: THREE.Group;
  private t = 0;
  private rimScan = 0;

  constructor(private readonly scene: THREE.Scene) {
    scene.add(this.group);
    scene.background = new THREE.Color(0x05070c);
    // Night haze in the driving snow: steel blue, silvered toward the moon in the fog chunk.
    scene.fog = new THREE.FogExp2(0x0b111c, 0.0068);

    this.sky = makeSky();
    this.group.add(this.sky);
    this.mountains = makeMountains();
    this.group.add(this.mountains);
    this.surround = new Surround();
    this.group.add(this.surround.group);
    this.group.add(this.banners.group);

    // Lights: one hard moon key from behind the general (long shadows raking toward the camera,
    // silver rims on both fighters), a faint cold sky fill so the shadow side is deep blue, not
    // black. Warm light comes only from the lanterns and the sparks.
    this.sun = new THREE.DirectionalLight(0xbfd2ff, 3.0);
    this.sun.position.copy(LIGHT_DIR).multiplyScalar(40);
    this.sun.castShadow = true;
    // One 4k map over the rooftop (~1 cm texels): crisp contact under the feet, and the Vogel-disk
    // PCF radius softens the edges a little (moonlight through snow).
    this.sun.shadow.mapSize.set(4096, 4096);
    const sc = this.sun.shadow.camera;
    sc.left = -17;
    sc.right = 17;
    sc.top = 17;
    sc.bottom = -17;
    sc.near = 10;
    sc.far = 75;
    this.sun.shadow.bias = -0.0003;
    this.sun.shadow.normalBias = 0.025;
    this.sun.shadow.radius = 2;
    scene.add(this.sun);
    scene.add(this.sun.target);
    scene.add(new THREE.HemisphereLight(0x22344f, 0x06080d, 0.55));
    // Cold front fill: the camera usually looks toward the moon, so this keeps the fighters'
    // visible sides readable (deep blue, never black).
    const fill = new THREE.DirectionalLight(0x6d84c4, 0.42);
    fill.position.set(-9, 6, 20);
    scene.add(fill);
  }

  /** Loads the Blender-built rooftop. */
  async load(renderer: THREE.WebGLRenderer): Promise<void> {
    const gltfLoader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    const gltf = await gltfLoader.loadAsync(`${ASSETS}arena.glb`);

    const root = gltf.scene;
    const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    const patched = new Set<THREE.Material>();
    root.traverse((o) => {
      if (!(o as THREE.Mesh).isMesh) return;
      const mesh = o as THREE.Mesh;
      const near = /^Roof_|^Lantern/.test(mesh.name) || /^Lantern/.test(mesh.parent?.name ?? "");
      // Only the rooftop sits inside the sun's shadow frustum; the floor tiles and snow receive
      // but don't cast (they're flat and 250k triangles).
      mesh.receiveShadow = near;
      mesh.castShadow = near && !/_clay|_snow/.test(mesh.name);
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        const mat = m as THREE.MeshStandardMaterial;
        if (patched.has(mat)) continue;
        patched.add(mat);
        for (const tex of [mat.map, mat.normalMap, mat.roughnessMap, mat.aoMap, mat.emissiveMap]) if (tex) tex.anisotropy = aniso;
        // Baked copies are named "<material>__<object>".
        const base = mat.name.split("__")[0];
        const snow = SNOW[base];
        if (snow) snowify(mat, snow);
        // Snow a little below white and cold: it takes the orange sun and the blue sky, and
        // stays under the bloom threshold instead of washing the rooftop out.
        if (base === "snow") mat.color.copy(SNOW_ALBEDO);
        // Lit shoji in the keep and the halls: the only sign of life down there.
        if (base === "window") {
          mat.emissive.set(0xffa860);
          mat.emissiveMap = mat.map;
          mat.emissiveIntensity = 2.2;
        }
      }
    });

    // Real snow over the fighting floor (wind-carved heightfield), detailed with the GLB's snow scan.
    let snowSrc: THREE.MeshStandardMaterial | null = null;
    root.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
      if (!snowSrc && m && !Array.isArray(m) && m.name.split("__")[0] === "snow") snowSrc = m;
    });
    const field = makeSnowField(snowSrc);
    snowify(field.material as THREE.MeshStandardMaterial, { amount: 0, glitter: 1.3 });
    this.group.add(field);

    // Lanterns: each swinging part gets its own paper material so they flicker out of step.
    const R = rng(17);
    const hangs: THREE.Object3D[] = [];
    root.traverse((o) => {
      if (/^LanternHang_\d+/.test(o.name)) hangs.push(o);
    });
    hangs.sort((a, b) => a.name.localeCompare(b.name));
    const haloMat = new THREE.SpriteMaterial({
      map: canvasTexture(64, 64, (g, w, h) => {
        const gr = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
        gr.addColorStop(0, "rgba(255,255,255,1)");
        gr.addColorStop(0.25, "rgba(255,255,255,0.45)");
        gr.addColorStop(1, "rgba(255,255,255,0)");
        g.fillStyle = gr;
        g.fillRect(0, 0, w, h);
      }),
      color: new THREE.Color(1.0, 0.4, 0.12).multiplyScalar(0.45),
      // Additive glow: fogging it toward the haze colour would brighten the mist, not dim the halo.
      fog: false,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });
    for (const hang of hangs) {
      let mat: THREE.MeshStandardMaterial | null = null;
      hang.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const m = mesh.material as THREE.MeshStandardMaterial;
        if (m.name === "lantern_paper") {
          if (!mat) {
            mat = m.clone();
            // Candle-warm paper: glTF exports the emissive as the white-balanced texture.
            mat.emissive.set(0xff5c1c);
          }
          mesh.material = mat;
        }
      });
      if (!mat) continue;
      // Soft glow around the paper (the bloom pass adds the tight core).
      const halo = new THREE.Sprite(haloMat);
      halo.scale.setScalar(1.5);
      halo.position.y = -0.3;
      halo.renderOrder = 5;
      hang.add(halo);
      const L: Lantern = { group: hang, phase: R() * 6, mat, rest: hang.quaternion.clone() };
      if (hang.name.endsWith("_L")) {
        const pl = new THREE.PointLight(0xff8a3c, LANTERN.light, 14, 1.3);
        pl.position.y = -0.45;
        hang.add(pl);
        L.light = pl;
      }
      this.lanterns.push(L);
    }
    this.group.add(root);

    this.loaded = true;
  }

  /** Give the fighters' rigid attachments the character rim (see tagCharacterRim). */
  tagCharacterRim(): void {
    tagCharacterRim(this.scene);
  }

  /** Finisher grade: 0..1 turns the moon to blood and drains the cloud sea. */
  set blood(v: number) {
    this.sky.material.uniforms.uBlood.value = v;
    for (const m of this.mountains.children) ((m as THREE.Mesh).material as THREE.ShaderMaterial).uniforms.uBlood.value = v;
    this.surround.blood = v;
  }

  update(dt: number, wind: number): void {
    this.t += dt;
    this.sky.material.uniforms.uTime.value = this.t;
    this.surround.update(this.t);
    this.banners.update(this.t, wind);
    // Fallback for bodies that appear after start-up (main.ts tags them before the shader warm-up).
    this.rimScan -= dt;
    if (this.rimScan <= 0) {
      this.rimScan = 1;
      this.tagCharacterRim();
    }
    for (const L of this.lanterns) {
      const k = 0.6 + wind;
      _euler.set(Math.sin(this.t * 1.3 + L.phase) * 0.07 * k, 0, Math.sin(this.t * 0.9 + L.phase * 2) * 0.05 * k);
      L.group.quaternion.copy(L.rest).multiply(_swing.setFromEuler(_euler));
      const flick = 1 + Math.sin(this.t * 11 + L.phase * 5) * 0.04 + Math.sin(this.t * 23 + L.phase) * 0.03;
      L.mat.emissiveIntensity = LANTERN.paper * flick;
      if (L.light) L.light.intensity = LANTERN.light * flick;
    }
  }
}
