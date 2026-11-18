/**
 * Nobori war banners on black poles along the ridge and the eaves: the general's colours,
 * whipping in the blizzard. They're the moving silhouettes against the moon, they throw moving
 * shadows across the snow, and they say whose roof this is.
 *
 * The flutter is a vertex wave (stronger toward the free edge and the foot of the banner) with
 * its analytic normal, shared by the depth material so the shadows flap with the cloth.
 */
import * as THREE from "three";
import { rng } from "../core/math";
import { brushText } from "../ui/brush";

const W = 0.78;
const H = 3.3;

const WAVE = /* glsl */ `
uniform float uTime;
uniform float uWind;
uniform float uPhase;
vec3 flutter(vec3 p, out vec3 n) {
  float u = clamp(p.x / ${W.toFixed(2)}, 0.0, 1.0);
  float v = clamp(-p.y / ${H.toFixed(2)}, 0.0, 1.0);
  float k = (0.22 + 0.78 * u) * (0.35 + 0.65 * v);
  float a = 0.1 + uWind * 0.16;
  float ph = uTime * (5.2 + uWind * 3.5) + uPhase;
  float w1 = sin(ph - u * 6.0 - v * 2.4);
  float w2 = sin(ph * 1.9 + v * 9.0 - u * 3.0 + 1.3);
  float z = (w1 * a + w2 * a * 0.32) * k;
  // Partial derivatives (per metre) for the normal.
  float dzdu = (-cos(ph - u * 6.0 - v * 2.4) * 6.0 * a - cos(ph * 1.9 + v * 9.0 - u * 3.0 + 1.3) * 3.0 * a * 0.32) * k
             + (w1 * a + w2 * a * 0.32) * 0.78 * (0.35 + 0.65 * v);
  float dzdv = (-cos(ph - u * 6.0 - v * 2.4) * 2.4 * a + cos(ph * 1.9 + v * 9.0 - u * 3.0 + 1.3) * 9.0 * a * 0.32) * k
             + (w1 * a + w2 * a * 0.32) * (0.22 + 0.78 * u) * 0.65;
  float dzdx = dzdu / ${W.toFixed(2)};
  float dzdy = -dzdv / ${H.toFixed(2)};
  n = normalize(vec3(-dzdx, -dzdy, 1.0));
  // The free edge also gets pulled downwind (toward +x) a touch.
  return vec3(p.x + u * v * uWind * 0.05, p.y, p.z + z);
}`;

function patch(mat: THREE.Material, uniforms: Record<string, THREE.IUniform>, normals: boolean): void {
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader.replace("#include <common>", `#include <common>\n${WAVE}`);
    if (normals) {
      sh.vertexShader = sh.vertexShader
        .replace("#include <beginnormal_vertex>", "vec3 flN; vec3 flP = flutter(position, flN);\nvec3 objectNormal = flN;")
        .replace("#include <begin_vertex>", "vec3 transformed = flP;");
    } else {
      sh.vertexShader = sh.vertexShader.replace("#include <begin_vertex>", "vec3 flN; vec3 transformed = flutter(position, flN);");
    }
  };
  mat.customProgramCacheKey = () => `banner-${normals}`;
}

function clothTexture(bg: string, fg: string, glyph: string, seed: number): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 512;
  const g = c.getContext("2d")!;
  const R = rng(seed);
  g.fillStyle = bg;
  g.fillRect(0, 0, 128, 512);
  // Weave and weathering.
  for (let i = 0; i < 1800; i++) {
    g.fillStyle = R() < 0.5 ? "rgba(0,0,0,0.08)" : "rgba(255,255,255,0.03)";
    g.fillRect(R() * 128, R() * 512, 1 + R() * 3, 1);
  }
  for (let i = 0; i < 6; i++) {
    const y = R() * 512;
    const gr = g.createLinearGradient(0, y - 40, 0, y + 40);
    gr.addColorStop(0, "rgba(0,0,0,0)");
    gr.addColorStop(0.5, "rgba(0,0,0,0.18)");
    gr.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = gr;
    g.fillRect(0, y - 40, 128, 80);
  }
  // Top band and a hem along the pole.
  g.fillStyle = fg;
  g.globalAlpha = 0.85;
  g.fillRect(0, 0, 128, 18);
  g.fillRect(0, 0, 8, 512);
  g.globalAlpha = 1;
  // The mon: a ring with the glyph inside, brushed.
  g.strokeStyle = fg;
  g.lineWidth = 7;
  g.beginPath();
  g.arc(66, 112, 44, 0, Math.PI * 2);
  g.stroke();
  const k = brushText(glyph, { size: 120, color: fg, seed: seed + 3, dry: 0.55, splatter: 0.2, pad: 10 });
  const s = 70 / Math.max(k.width, k.height);
  g.drawImage(k, 66 - (k.width * s) / 2, 112 - (k.height * s) / 2, k.width * s, k.height * s);
  const k2 = brushText(glyph === "鬼" ? "影" : "鬼", { size: 160, color: fg, seed: seed + 9, dry: 0.7, splatter: 0.3, pad: 10 });
  const s2 = 110 / Math.max(k2.width, k2.height);
  g.globalAlpha = 0.9;
  g.drawImage(k2, 66 - (k2.width * s2) / 2, 290 - (k2.height * s2) / 2, k2.width * s2, k2.height * s2);
  g.globalAlpha = 1;
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Ragged edges and wind-torn holes (white = cloth). */
function tearMask(seed: number, torn: number): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 256;
  const g = c.getContext("2d")!;
  const R = rng(seed);
  g.fillStyle = "#fff";
  g.fillRect(0, 0, 64, 256);
  g.fillStyle = "#000";
  // Frayed foot: tongues of cloth of uneven length.
  for (let x = 0; x < 64; x += 2) {
    const len = 4 + R() * (10 + torn * 46) * (0.4 + (x / 64) * 0.9);
    g.fillRect(x, 256 - len, 2 + R() * 2, len);
  }
  // Frayed free edge.
  for (let y = 20; y < 256; y += 3) {
    const len = R() * (2 + torn * 10) * (y / 256);
    g.fillRect(64 - len, y, len, 3);
  }
  for (let i = 0; i < torn * 7; i++) {
    g.beginPath();
    g.ellipse(18 + R() * 40, 120 + R() * 120, 2 + R() * 5, 4 + R() * 12, R() * 3, 0, Math.PI * 2);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  return t;
}

interface BannerDef {
  x: number;
  z: number;
  /** Pole yaw: the cloth hangs toward +x of the rotated frame. */
  yaw: number;
  lean?: number;
  red?: boolean;
  torn?: number;
  h?: number;
}

/** The blizzard blows toward -x / +z; local +x (the free edge) streams downwind at yaw ≈ 3.6. */
const DOWNWIND = 3.6;
const DEFS: BannerDef[] = [
  { x: -9.6, z: -12.25, yaw: DOWNWIND + 0.1, red: false, torn: 0.3 },
  { x: 2.6, z: -12.35, yaw: DOWNWIND - 0.08, red: true, torn: 0.5, h: 4.7 },
  { x: 9.4, z: -12.2, yaw: DOWNWIND + 0.15, lean: -0.06, red: false, torn: 0.9 },
  { x: -12.15, z: 3.5, yaw: DOWNWIND - 0.2, red: true, torn: 0.4, h: 4.0 },
  { x: 12.15, z: -4.5, yaw: DOWNWIND + 0.05, lean: 0.1, red: false, torn: 0.7 },
];

export class Banners {
  readonly group = new THREE.Group();
  private readonly uniforms: { u: Record<string, THREE.IUniform> }[] = [];

  constructor() {
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x0b0a0c, roughness: 0.45, metalness: 0.1 });
    const capMat = new THREE.MeshStandardMaterial({ color: 0x6b5530, roughness: 0.35, metalness: 0.9 });
    const tex = {
      black: clothTexture("#15161c", "#d9d4c8", "鬼", 31),
      red: clothTexture("#5c0d0a", "#100c0c", "影", 37),
    };
    DEFS.forEach((d, i) => {
      const poleH = d.h ?? 4.4;
      const root = new THREE.Group();
      root.position.set(d.x, 0, d.z);
      root.rotation.set(0, d.yaw, d.lean ?? 0);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.045, poleH, 8), poleMat);
      pole.position.y = poleH / 2;
      pole.castShadow = true;
      const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, W + 0.12, 6), poleMat);
      bar.rotation.z = Math.PI / 2;
      bar.position.set((W + 0.12) / 2, poleH - 0.12, 0);
      bar.castShadow = true;
      const cap = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.22, 8), capMat);
      cap.position.y = poleH + 0.11;
      root.add(pole, bar, cap);

      const u: Record<string, THREE.IUniform> = {
        uTime: { value: 0 },
        uWind: { value: 0.5 },
        uPhase: { value: i * 1.7 },
      };
      const alpha = tearMask(90 + i, d.torn ?? 0.3);
      const geo = new THREE.PlaneGeometry(W, H, 10, 28);
      geo.translate(W / 2, -H / 2, 0);
      const mat = new THREE.MeshStandardMaterial({
        map: d.red ? tex.red : tex.black,
        alphaMap: alpha,
        alphaTest: 0.5,
        side: THREE.DoubleSide,
        roughness: 0.92,
        metalness: 0,
      });
      patch(mat, u, true);
      const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, alphaMap: alpha, alphaTest: 0.5 });
      patch(depth, u, false);
      const cloth = new THREE.Mesh(geo, mat);
      cloth.customDepthMaterial = depth;
      cloth.castShadow = true;
      cloth.receiveShadow = true;
      cloth.position.set(0.04, poleH - 0.16, 0);
      root.add(cloth);
      this.uniforms.push({ u });
      this.group.add(root);
    });
  }

  update(t: number, wind: number): void {
    for (const { u } of this.uniforms) {
      u.uTime.value = t;
      u.uWind.value = wind;
    }
  }
}
