/**
 * The snow lying on the fighting floor, as real geometry: a heightfield laid over the tiles and
 * carved by the wind. Long dunes run downwind, sastrugi ripple across it, and it piles up against
 * the ridge and the eaves. Where it's deep the tiles are buried outright; where it thins the tile
 * ribs break through as dotted lines; where the wind has scoured the roof the black tiles are
 * bare. That breaks the one repeating tile pattern into a landscape.
 *
 * Gameplay floor is y = 0 (tile crests are at ~+0.08, channels at ~-0.08). The snow is capped
 * low over the middle of the roof so feet sink at most ankle-deep where the fighting happens.
 */
import * as THREE from "three";
import { rng } from "../core/math";
import { WIND_XZ } from "./materials";

const X0 = -13.4;
const X1 = 13.4;
const Z0 = -12.4;
const Z1 = 13.7;

function noise2(seed: number): (x: number, y: number) => number {
  const R = rng(seed);
  const N = 256;
  const g = new Float32Array(N * N);
  for (let i = 0; i < g.length; i++) g[i] = R();
  const at = (x: number, y: number) => g[(((y % N) + N) % N) * N + (((x % N) + N) % N)];
  return (x, y) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const u = xf * xf * (3 - 2 * xf);
    const v = yf * yf * (3 - 2 * yf);
    const a = at(xi, yi);
    const b = at(xi + 1, yi);
    const c = at(xi, yi + 1);
    const d = at(xi + 1, yi + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
}

const sstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export function snowHeight(): (x: number, z: number) => number {
  const n1 = noise2(71);
  const n2 = noise2(72);
  const n3 = noise2(73);
  const wd = WIND_XZ;
  return (x, z) => {
    const a = x * wd.x + z * wd.y; // downwind
    const c = -x * wd.y + z * wd.x; // across
    const dune = n1(a * 0.09, c * 0.3) * 0.62 + n2(a * 0.21 + 4, c * 0.62) * 0.38;
    // Lee piles: against the ridge, the side eaves, and a little everywhere downwind of the posts.
    const lee = sstep(-4, -11.8, z) * 0.32 + sstep(7, 12.5, Math.abs(x)) * 0.22 + sstep(8, 13, z) * 0.12;
    const d = sstep(0.3, 0.62, dune + lee);
    // Sastrugi: wind-cut ridges across the flow, only where there's snow to cut.
    const rip = (n3(a * 0.7, c * 4.2) - 0.5) * 0.05 * d + Math.sin(c * 9 + n3(a * 0.3, c * 0.8) * 6) * 0.006 * d;
    const r = Math.max(Math.abs(x), Math.abs(z - 0.6));
    const cap = 0.105 + sstep(5.5, 10.5, r) * 0.16;
    let h = -0.075 + Math.min(d * 0.32, cap + 0.075) + rip;
    // Dip under the tiles at the very edge so the sheet never shows a cut edge.
    const edge = Math.min(x - X0, X1 - x, z - Z0, Z1 - z);
    h -= (1 - sstep(0.15, 0.9, edge)) * 0.25;
    return h;
  };
}

export function makeSnowField(source: THREE.MeshStandardMaterial | null): THREE.Mesh {
  const NX = 320;
  const NZ = 310;
  const geo = new THREE.PlaneGeometry(X1 - X0, Z1 - Z0, NX, NZ);
  geo.rotateX(-Math.PI / 2);
  geo.translate((X0 + X1) / 2, 0, (Z0 + Z1) / 2);
  const h = snowHeight();
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  const uv = geo.getAttribute("uv") as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    pos.setY(i, h(x, z));
    uv.setXY(i, x * 0.45, z * 0.45);
  }
  geo.setAttribute("uv1", uv.clone());
  geo.computeVertexNormals();
  const mat = source ? source.clone() : new THREE.MeshStandardMaterial();
  mat.name = "snowfield";
  mat.color.setRGB(0.6, 0.66, 0.78);
  mat.roughness = 0.82;
  mat.metalness = 0;
  // The baked AO belongs to the GLB's own snow sheet, not to this surface.
  mat.aoMap = null;
  for (const t of [mat.map, mat.normalMap, mat.roughnessMap]) {
    if (!t) continue;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.needsUpdate = true;
  }
  if (mat.normalScale) mat.normalScale.setScalar(0.6);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = "SnowField";
  mesh.receiveShadow = true;
  return mesh;
}
