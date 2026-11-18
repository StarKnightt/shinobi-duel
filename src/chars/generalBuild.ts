/**
 * The samurai general's body: a laced lamellar dō (rows of black-lacquered lames bound with
 * dense orange-red kebiki lacing, gold-rimmed lowest rows), six flaring kusazuri, broad sode,
 * a ribbed kabuto with a wide four-lame shikoro, turn-backs and tall golden kuwagata, a
 * snarling menpō with a white moustache and a laced throat guard, mail sleeves with iron
 * splint forearms, a lamellar haidate apron, iron suneate and armoured shoes.
 */
import * as THREE from "three";
import { rimLit } from "../world/materials";
import type { Rig, RigDims } from "./Rig";
import { katana } from "./parts";
import {
  clothSet,
  folds,
  gripHand,
  ironSet,
  lameSet,
  lameStack,
  loft,
  mailSet,
  mergeGroup,
  sculptMenpo,
  smoothRings,
  tube,
  type Ring,
  type TexSet,
} from "./sculpt";

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

function withSet<T extends THREE.MeshStandardMaterial>(m: T, set: TexSet | null, repeat: [number, number] = [1, 1], nScale = 1): T {
  if (set) {
    const map = set.map.clone();
    const nm = set.normalMap.clone();
    map.repeat.set(...repeat);
    nm.repeat.set(...repeat);
    map.needsUpdate = nm.needsUpdate = true;
    m.map = map;
    m.normalMap = nm;
    m.normalScale.set(nScale, nScale);
  }
  return m;
}

function add(parent: THREE.Object3D, geo: THREE.BufferGeometry, m: THREE.Material, pos?: THREE.Vector3, rot?: THREE.Euler): THREE.Mesh {
  const mesh = new THREE.Mesh(geo, m);
  if (pos) mesh.position.copy(pos);
  if (rot) mesh.rotation.copy(rot);
  mesh.castShadow = true;
  parent.add(mesh);
  return mesh;
}

export interface GeneralParts {
  sode: THREE.Group[];
  skirt: { g: THREE.Group; side: number; ang: number }[];
}

export function buildGeneral(r: Rig, d: RigDims): GeneralParts {
  // ---------------------------------------------------------------- materials
  const lacquer = (set: TexSet, rep: [number, number], rim = 1.3) =>
    rimLit(
      withSet(
        new THREE.MeshPhysicalMaterial({ roughness: 0.4, metalness: 0.12, clearcoat: 0.8, clearcoatRoughness: 0.28, side: THREE.DoubleSide }),
        set,
        rep,
        1.4,
      ),
      rim,
    );
  const lameT = lameSet("#171213", "#7e171b", 201, { cols: 22 });
  const lameGoldT = lameSet("#171213", "#7e171b", 202, { cols: 22, cross: true, gold: true });
  const lameFineT = lameSet("#141012", "#c84c1a", 203, { cols: 40 });
  const lame = lacquer(lameT, [3, 1]);
  const lameGold = lacquer(lameGoldT, [3, 1]);
  const lameSm = lacquer(lameT, [1.2, 1]);
  const lameSmGold = lacquer(lameGoldT, [1.2, 1]);
  const lameFine = lacquer(lameFineT, [1, 1]);
  const ironT = ironSet("#1f1d1d", 204, { rivets: 12, rust: 0.6 });
  const iron = rimLit(withSet(new THREE.MeshStandardMaterial({ metalness: 0.7, roughness: 0.42, color: 0xb0aaa4 }), ironT, [1, 1], 1.2), 1.2);
  const blackLac = rimLit(
    withSet(new THREE.MeshPhysicalMaterial({ color: 0x9a9090, roughness: 0.28, metalness: 0.25, clearcoat: 1, clearcoatRoughness: 0.14 }), ironSet("#0f0d0d", 205, { rust: 0.1 }), [1, 1], 0.6),
    1.2,
  );
  const gold = rimLit(new THREE.MeshStandardMaterial({ color: 0xb3a68a, metalness: 1, roughness: 0.32, emissive: 0x140e06, emissiveIntensity: 0.3 }), 1.0);
  // Horns: dark antique gold (pale brass reads white under the moon and turns them into antennae).
  const hornGold = rimLit(new THREE.MeshStandardMaterial({ color: 0x8c6a32, metalness: 1, roughness: 0.4, emissive: 0x120804, emissiveIntensity: 0.3 }), 0.8);
  const redIron = rimLit(
    withSet(new THREE.MeshPhysicalMaterial({ color: 0xc8c0bc, roughness: 0.38, metalness: 0.3, clearcoat: 0.9, clearcoatRoughness: 0.2 }), ironSet("#7a1510", 206, { rust: 0.3 }), [1, 1], 0.8),
    1.1,
  );
  const mail = rimLit(withSet(new THREE.MeshStandardMaterial({ metalness: 0.55, roughness: 0.5, color: 0xffffff }), mailSet(207), [4, 4], 1.4), 1.0);
  const hakama = rimLit(withSet(new THREE.MeshStandardMaterial({ roughness: 0.95, side: THREE.DoubleSide }), clothSet("#3c2420", 208, { folds: 12, patches: 1, grime: 1.1 }), [2, 1.4], 1.3), 1.0);
  const lace = rimLit(new THREE.MeshStandardMaterial({ color: 0x7e171b, roughness: 0.7 }), 1.0);
  const whiteHair = rimLit(new THREE.MeshStandardMaterial({ color: 0xd9d2c4, roughness: 0.9 }), 0.8);
  const leather = rimLit(new THREE.MeshStandardMaterial({ color: 0x1b1412, roughness: 0.55 }), 1.0);
  const shadowFace = new THREE.MeshStandardMaterial({ color: 0x050404, roughness: 1 });

  // ---------------------------------------------------------------- hips: hakama, obi, kusazuri
  const waist: Ring[] = [
    { y: -0.18, w: 0.225, d: 0.18 },
    { y: 0.0, w: 0.21, d: 0.17 },
    { y: 0.16, w: 0.19, d: 0.15 },
  ];
  add(r.hips, loft(smoothRings(waist, 6), 24, { bump: folds(10, 0.01, 3) }), hakama);
  add(r.hips, loft([{ y: 0.07, w: 0.205, d: 0.165 }, { y: 0.17, w: 0.2, d: 0.16 }], 24), leather);
  const skirt: GeneralParts["skirt"] = [];
  const skirtN = 6;
  for (let i = 0; i < skirtN; i++) {
    const ang = ((i + 0.5) / skirtN) * Math.PI * 2;
    const g = new THREE.Group();
    g.position.set(0, 0.1, 0);
    g.rotation.y = ang;
    const span = 0.5;
    const top = lameStack(4, 0.072, 0.066, (k) => [0.22 + k * 0.022, 0.235 + k * 0.022], -span, span, 8, 0.008);
    add(g, top, lameSm);
    const bot = lameStack(1, 0.075, 0.07, () => [0.31, 0.325], -span, span, 8, 0.009).translate(0, -4 * 0.066, 0);
    add(g, bot, lameSmGold);
    // Suspension cords.
    for (const s of [-0.3, 0, 0.3]) add(g, tube([V(Math.sin(s) * 0.205, 0.04, Math.cos(s) * 0.205), V(Math.sin(s) * 0.225, -0.01, Math.cos(s) * 0.225)], 0.006, 0.006, 1, 4, 5), lace);
    r.hips.add(g);
    skirt.push({ g, side: Math.sin(ang) < 0 ? 0 : 1, ang });
  }

  // ---------------------------------------------------------------- torso: dō
  const torso: Ring[] = [
    { y: -0.07, w: 0.19, d: 0.15 },
    { y: 0.1, w: 0.2, d: 0.16 },
    { y: 0.26, w: 0.225, d: 0.17 },
    { y: 0.36, w: 0.2, d: 0.14 },
    { y: 0.43, w: 0.1, d: 0.09 },
  ];
  add(r.chest, loft(smoothRings(torso, 10), 24), mail);
  // Lames round the body, top to waist; the lowest two gold-rimmed with cross knots.
  const rows = 8;
  for (let k = 0; k < rows; k++) {
    const y = 0.33 - k * 0.05;
    const wTop = 0.235 - Math.abs(k - 2) * 0.006 - (k > 4 ? (k - 4) * 0.008 : 0);
    const g = lameStack(1, 0.056, 0.05, () => [1, 1.02], 0, Math.PI * 2, 28, 0.02);
    g.scale(wTop, 1, wTop * 0.8);
    g.translate(0, y, 0);
    add(r.chest, g, k >= rows - 2 ? lameGold : lame);
  }
  // Munaita (breast plate) and shoulder straps with gold fittings.
  const muna = loft(
    [
      { y: 0.33, w: 0.2, d: 0.175 },
      { y: 0.4, w: 0.17, d: 0.15 },
    ],
    16,
    { t0: -0.9, t1: 0.9 },
  );
  add(r.chest, muna, blackLac);
  add(r.chest, tube([V(-0.17, 0.4, 0.105), V(0, 0.412, 0.155), V(0.17, 0.4, 0.105)], 0.009, 0.009, 1, 12, 5), gold);
  for (const s of [-1, 1]) {
    add(r.chest, tube([V(s * 0.1, 0.42, 0.12), V(s * 0.15, 0.45, 0.0), V(s * 0.12, 0.42, -0.13)], 0.03, 0.03, 0.4, 12, 6), blackLac);
    add(r.chest, new THREE.SphereGeometry(0.018, 8, 6), gold, V(s * 0.13, 0.43, 0.11));
  }
  // Agemaki bow at the back.
  add(r.chest, tube([V(0, 0.2, -0.19), V(-0.05, 0.23, -0.2), V(-0.06, 0.18, -0.2), V(0, 0.2, -0.19), V(0.05, 0.23, -0.2), V(0.06, 0.18, -0.2), V(0, 0.2, -0.19)], 0.009, 0.009, 1, 30, 5), lace);
  // Kamon on the breast.
  add(r.chest, new THREE.TorusGeometry(0.034, 0.006, 6, 20), gold, V(0, 0.29, 0.195), new THREE.Euler(-0.3, 0, 0));
  add(r.chest, new THREE.TorusGeometry(0.018, 0.005, 6, 16), gold, V(0, 0.29, 0.197), new THREE.Euler(-0.3, 0, 0));
  // Laced collar.
  add(r.chest, lameStack(2, 0.04, 0.034, (k) => [0.11 + k * 0.012, 0.125 + k * 0.012], 0, Math.PI * 2, 20, 0.006).translate(0, 0.47, 0), lameFine);

  // Sode.
  const sode: THREE.Group[] = [];
  for (let i = 0; i < 2; i++) {
    const sd = i === 0 ? -1 : 1;
    const g = new THREE.Group();
    g.position.set(sd * 0.25, 0.41, 0);
    const st = lameStack(5, 0.066, 0.06, (k) => [0.26 + k * 0.006, 0.265 + k * 0.006], -0.48, 0.48, 10, 0.009);
    const sb = lameStack(1, 0.07, 0.064, () => [0.3, 0.305], -0.48, 0.48, 10, 0.01).translate(0, -5 * 0.06, 0);
    for (const geo of [st, sb]) {
      geo.rotateY(sd * Math.PI * 0.5);
      geo.translate(-sd * 0.235, 0, 0);
      geo.rotateZ(sd * 0.12);
    }
    add(g, st, lameSm);
    add(g, sb, lameSmGold);
    add(g, tube([V(sd * 0.03, 0.01, -0.12), V(sd * 0.05, 0.02, 0), V(sd * 0.03, 0.01, 0.12)], 0.012, 0.012, 0.5, 10, 5), blackLac);
    r.chest.add(g);
    sode.push(g);
  }

  // ---------------------------------------------------------------- head: kabuto + menpō
  add(r.head, loft([{ y: -0.08, w: 0.07, d: 0.072 }, { y: 0.07, w: 0.064, d: 0.066 }], 14), mail);
  add(r.head, new THREE.SphereGeometry(0.095, 16, 12), shadowFace, V(0, 0.11, 0.0)).scale.set(0.95, 1.05, 1);
  // Hachi: a ribbed, riveted bowl.
  const bowlProf: THREE.Vector2[] = [];
  for (let k = 0; k <= 10; k++) {
    const a = (k / 10) * Math.PI * 0.5;
    bowlProf.push(new THREE.Vector2(Math.cos(a) * 0.135 + 0.001, Math.sin(a) * 0.125));
  }
  // Suji-bachi: the ridges are raised in the bowl's own surface (thin tubes catch the fresnel rim
  // over their whole width and read as a white birdcage).
  const bowl = new THREE.LatheGeometry(bowlProf.reverse(), 120);
  {
    const bp = bowl.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < bp.count; i++) {
      const x = bp.getX(i);
      const z = bp.getZ(i);
      const ridge = 1 + 0.03 * Math.pow(Math.max(0, Math.cos(Math.atan2(x, z) * 20)), 10);
      bp.setX(i, x * ridge);
      bp.setZ(i, z * ridge);
    }
    bowl.computeVertexNormals();
  }
  bowl.scale(1, 1, 1.08);
  add(r.head, bowl, blackLac, V(0, 0.15, 0));
  add(r.head, new THREE.TorusGeometry(0.022, 0.007, 6, 14), gold, V(0, 0.275, 0), new THREE.Euler(Math.PI / 2, 0, 0));
  // Koshimaki band and peak.
  add(r.head, loft([{ y: 0.14, w: 0.14, d: 0.151 }, { y: 0.165, w: 0.138, d: 0.149 }], 32), gold);
  add(r.head, loft([{ y: 0.155, w: 0.15, d: 0.17 }, { y: 0.14, w: 0.18, d: 0.22 }], 20, { t0: -1.1, t1: 1.1 }), blackLac);
  // Shikoro: four close-fitting lames sloping down over the nape and shoulders (hineno style),
  // open at the face; a gold-edged bottom lame. Tight to the head so the silhouette stays a head,
  // not a hat: the horns carry the menace.
  const shik = lameStack(4, 0.052, 0.044, (k) => [0.146 + k * 0.019, 0.163 + k * 0.019], 1.05, Math.PI * 2 - 1.05, 28, 0.007);
  add(r.head, shik, lameFine, V(0, 0.145, 0));
  const shikB = lameStack(1, 0.05, 0.044, () => [0.222, 0.236], 1.05, Math.PI * 2 - 1.05, 28, 0.009);
  add(r.head, shikB, lameGold, V(0, 0.145 - 4 * 0.044, 0));
  // Fukigaeshi: the top lames turned back beside the face.
  for (const s of [-1, 1]) {
    const f = lameStack(2, 0.045, 0.04, (k) => [0.1 + k * 0.01, 0.11 + k * 0.01], -0.45, 0.45, 8, 0.007);
    f.rotateY(s * 1.25);
    add(r.head, f, lameSm, V(s * 0.075, 0.165, 0.11), new THREE.Euler(0, s * 0.55, s * 0.2));
  }
  // Kuwagata: broad horn-blades sweeping out of the brow and hooking inward at the tips (an oni's
  // horns, not antennae). Flat plates, as a real kuwagata is: a thin tube catches the fresnel rim
  // over its whole width and reads white whatever its colour.
  for (const s of [-1, 1]) {
    const sh = new THREE.Shape();
    const P = (pts: [number, number][]) => pts.map(([x, y]) => new THREE.Vector2(s * x, y));
    sh.moveTo(s * 0.02, 0);
    sh.splineThru(P([[0.1, 0.045], [0.19, 0.12], [0.245, 0.22], [0.24, 0.31], [0.19, 0.37]]));
    sh.splineThru(P([[0.2, 0.31], [0.195, 0.235], [0.155, 0.16], [0.085, 0.095], [0.02, 0.055]]));
    sh.closePath();
    const hg = new THREE.ExtrudeGeometry(sh, { depth: 0.012, bevelEnabled: true, bevelThickness: 0.004, bevelSize: 0.004, bevelSegments: 1, curveSegments: 10 });
    hg.translate(0, 0, -0.006);
    add(r.head, hg, hornGold, V(0, 0.2, 0.158), new THREE.Euler(-0.22, s * -0.18, 0));
  }
  add(r.head, new THREE.CylinderGeometry(0.045, 0.045, 0.01, 24), gold, V(0, 0.235, 0.165), new THREE.Euler(Math.PI / 2 - 0.2, 0, 0));
  add(r.head, new THREE.CylinderGeometry(0.03, 0.03, 0.014, 20), redIron, V(0, 0.235, 0.17), new THREE.Euler(Math.PI / 2 - 0.2, 0, 0));
  add(r.head, loft([{ y: 0.16, w: 0.03, d: 0.02 }, { y: 0.22, w: 0.015, d: 0.012 }], 8), gold, V(0, 0, 0.155));
  // Menpō with a white moustache, ember eyes in the shadow, and a laced throat guard.
  const menpo = add(r.head, sculptMenpo(0.103), redIron, V(0, 0.105, 0.0));
  menpo.scale.set(1, 1.05, 1.08);
  const eyeMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(4, 0.9, 0.3) });
  for (const s of [-1, 1]) {
    const e = new THREE.Mesh(new THREE.SphereGeometry(0.009, 8, 6), eyeMat);
    e.scale.set(1.7, 0.55, 0.6);
    e.position.set(s * 0.036, 0.132, 0.092);
    e.userData.keep = true;
    r.head.add(e);
    for (let h = 0; h < 6; h++) {
      const x0 = s * (0.012 + h * 0.006);
      add(r.head, tube([V(x0, 0.085, 0.132), V(x0 + s * 0.03, 0.07, 0.125), V(x0 + s * 0.05, 0.03 - h * 0.004, 0.105)], 0.0045, 0.001, 1, 8, 4), whiteHair);
    }
  }
  const yodare = lameStack(3, 0.04, 0.036, (k) => [0.1 + k * 0.016, 0.115 + k * 0.016], -1.4, 1.4, 16, 0.006);
  add(r.head, yodare, lameFine, V(0, 0.03, 0.0));

  // ---------------------------------------------------------------- arms
  for (let i = 0; i < 2; i++) {
    add(r.uArm[i], new THREE.SphereGeometry(0.078, 14, 10), mail);
    add(r.uArm[i], loft(smoothRings([{ y: -0.02, w: 0.078, d: 0.074 }, { y: 0.15, w: 0.074, d: 0.07 }, { y: d.upperArm + 0.02, w: 0.064, d: 0.06 }], 6), 14, { bump: folds(4, 0.006, 70 + i) }), mail);
    // Upper-arm kote: three laced lamellar rows flaring toward the elbow, a padded cloth sleeve
    // bulging out below them, and a gold-rimmed iron elbow cop.
    const ua = lameStack(3, 0.056, 0.05, (k) => [0.084 + k * 0.004, 0.092 + k * 0.004], 0, Math.PI * 2, 18, 0.008);
    ua.rotateX(Math.PI);
    ua.translate(0, 0.04, 0);
    add(r.uArm[i], ua, lameSm);
    add(r.uArm[i], loft([{ y: 0.04, w: 0.089, d: 0.085 }, { y: 0.046, w: 0.091, d: 0.087 }], 18), gold);
    add(r.uArm[i], loft(smoothRings([{ y: 0.17, w: 0.08, d: 0.076 }, { y: 0.22, w: 0.088, d: 0.084 }, { y: d.upperArm + 0.01, w: 0.07, d: 0.066 }], 4), 16, { bump: folds(6, 0.01, 90 + i, 1.4) }), hakama);
    add(r.uArm[i], new THREE.SphereGeometry(0.05, 12, 8, 0, Math.PI * 2, 0, 1.3), iron, V(0, d.upperArm, -0.045), new THREE.Euler(-Math.PI / 2, 0, 0));
    // Kote: mail sleeve with iron splints (ikada) and gold bands.
    add(r.fArm[i], new THREE.SphereGeometry(0.062, 12, 8), iron);
    add(r.fArm[i], loft(smoothRings([{ y: -0.01, w: 0.062, d: 0.058 }, { y: 0.16, w: 0.058, d: 0.054 }, { y: d.foreArm - 0.04, w: 0.047, d: 0.044 }], 6), 14), mail);
    for (let k = 0; k < 3; k++) {
      const g = loft([{ y: 0.03, w: 0.068, d: 0.064 }, { y: d.foreArm - 0.08, w: 0.056, d: 0.052 }], 6, { t0: -0.35 + (k - 1) * 0.72, t1: 0.35 + (k - 1) * 0.72 });
      add(r.fArm[i], g, blackLac);
    }
    for (const y of [0.03, d.foreArm - 0.07]) add(r.fArm[i], loft([{ y, w: 0.07, d: 0.066 }, { y: y + 0.014, w: 0.069, d: 0.065 }], 16), gold);
    const gh = gripHand(0.017, 1.12);
    add(r.hand[i], gh.skin, leather);
    add(r.hand[i], gh.back, blackLac);
  }

  // ---------------------------------------------------------------- legs
  for (let i = 0; i < 2; i++) {
    const sd = i === 0 ? -1 : 1;
    add(r.thigh[i], loft(smoothRings([{ y: -0.08, w: 0.14, d: 0.14 }, { y: 0.2, w: 0.155, d: 0.15 }, { y: d.thigh + 0.04, w: 0.16, d: 0.155 }], 6), 18, { bump: folds(6, 0.012, 80 + i, 1.4) }), hakama);
    // Haidate: a small-plate apron over the front of the thigh.
    const hd = lameStack(4, 0.06, 0.055, (k) => [0.165 + k * 0.003, 0.17 + k * 0.003], -1.0, 1.0, 12, 0.006);
    hd.rotateX(Math.PI);
    hd.rotateY(sd * -0.25);
    add(r.thigh[i], hd, lameFine, V(0, 0.08, 0));
    // Hakama gathered under the knee, suneate, knee plate.
    add(r.shin[i], loft(smoothRings([{ y: -0.05, w: 0.14, d: 0.14 }, { y: 0.06, w: 0.13, d: 0.13 }, { y: 0.13, w: 0.08, d: 0.08 }], 6), 16, { bump: folds(6, 0.01, 90 + i, 1.4) }), hakama);
    add(r.shin[i], loft(smoothRings([{ y: 0.08, w: 0.066, d: 0.066 }, { y: 0.25, w: 0.058, d: 0.06 }, { y: d.shin - 0.02, w: 0.05, d: 0.052 }], 6), 12), mail);
    for (let k = 0; k < 3; k++) {
      const g = loft([{ y: 0.12, w: 0.078, d: 0.08 }, { y: 0.3, w: 0.072, d: 0.075 }, { y: d.shin - 0.04, w: 0.06, d: 0.064 }], 6, { t0: -0.42 + (k - 1) * 0.86, t1: 0.42 + (k - 1) * 0.86 });
      add(r.shin[i], g, iron);
    }
    for (const y of [0.13, d.shin - 0.05]) add(r.shin[i], loft([{ y, w: 0.082, d: 0.084 }, { y: y + 0.012, w: 0.08, d: 0.082 }], 16), gold);
    add(r.shin[i], new THREE.SphereGeometry(0.075, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.55), blackLac, V(0, 0.05, 0.05), new THREE.Euler(1.3, 0, 0)).scale.set(1, 1, 0.55);
    // Armoured shoe.
    const foot = loft(smoothRings([{ y: -0.07, w: 0.045, d: 0.048 }, { y: 0.0, w: 0.055, d: 0.052 }, { y: 0.1, w: 0.056, d: 0.036 }, { y: 0.19, w: 0.03, d: 0.02 }], 8), 14, { capTop: true, capBot: true });
    foot.rotateX(Math.PI / 2);
    add(r.foot[i], foot, leather, V(0, -0.05, 0.02));
    add(r.foot[i], loft([{ y: 0.0, w: 0.058, d: 0.056 }, { y: 0.12, w: 0.052, d: 0.04 }], 8, { t0: -1.2, t1: 1.2 }).rotateX(Math.PI / 2).rotateX(-0.25), iron, V(0, -0.03, 0.02));
    add(r.foot[i], new THREE.SphereGeometry(0.06, 10, 8), leather, V(0, 0, -0.01));
  }

  // Saya on the left hip.
  const saya = new THREE.Group();
  saya.position.set(0.23, 0.1, 0.1);
  saya.quaternion.setFromUnitVectors(V(0, 1, 0), V(0.25, -0.35, -1).normalize());
  add(saya, loft([{ y: -0.02, w: 0.022, d: 0.033 }, { y: 1.0, w: 0.017, d: 0.026 }, { y: 1.02, w: 0.01, d: 0.015 }], 10, { capTop: true }), blackLac);
  for (const y of [0.0, 0.2, 0.98]) add(saya, loft([{ y, w: 0.025, d: 0.036 }, { y: y + 0.03, w: 0.025, d: 0.036 }], 10), gold);
  r.hips.add(saya);

  // ---------------------------------------------------------------- sword
  r.sword.add(katana(d.tsuba, d.blade, { tsukaColor: "#5a1010", tsubaGold: true, sori: 0.03 }));

  for (const g of [r.hips, r.chest, r.head, ...r.uArm, ...r.fArm, ...r.hand, ...r.thigh, ...r.shin, ...r.foot, saya, ...sode, ...skirt.map((s) => s.g)]) mergeGroup(g);
  return { sode, skirt };
}
