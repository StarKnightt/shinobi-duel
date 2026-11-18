/**
 * The shinobi: ~1.75 m, grey-brown kimono and wide hakama, wrapped shins, a dark iron plate on
 * the left shoulder and a gauntlet on the left forearm, face half-masked, a long rust-red scarf
 * that trails in the wind. Katana in the right hand, black saya on the left hip.
 */
import * as THREE from "three";
import { PROCEDURAL_PLAYER } from "./animEvents";
import { Cloth } from "./Cloth";
import { Character } from "./Character";
import { Clip, I, pose, type Pose } from "./Pose";
import type { RigDims } from "./Rig";
import { buildShinobi, type ShinobiParts } from "./shinobiBuild";

export const SHINOBI_DIMS: RigDims = {
  hipH: 0.92,
  hipW: 0.095,
  waist: 0.14,
  shoulderY: 0.36,
  shoulderW: 0.185,
  neckY: 0.46,
  upperArm: 0.29,
  foreArm: 0.33,
  thigh: 0.44,
  shin: 0.43,
  ankle: 0.08,
  tsuba: 0.075,
  blade: 0.95,
  capR: 0.3,
  scale: 1,
};

// ---------------------------------------------------------------------------- poses
const S = pose(null, {
  grip: [0.2, 1.0, 0.34],
  dir: [-0.12, 0.5, 1],
  lhand: [-0.26, 0.98, 0.1],
  two: 0,
  hipY: -0.07,
  hipYaw: 0.22,
  chestYaw: 0.05,
  chestPitch: 0.12,
  head: -0.08,
  lean: 0.02,
  footL: [-0.14, 0, 0.17],
  footR: [0.16, 0, -0.17],
  gait: 1,
});
const S2 = pose(S, { chestPitch: 0.15, hipY: -0.08, grip: [0.2, 0.985, 0.35], dir: [-0.1, 0.46, 1] });
const RUN = pose(S, {
  grip: [0.3, 0.95, -0.12],
  dir: [0.25, 0.1, -1],
  lhand: [-0.25, 1.02, 0.25],
  chestPitch: 0.36,
  lean: 0.13,
  hipYaw: 0,
  chestYaw: 0,
  head: -0.26,
  hipY: -0.06,
  footL: [-0.11, 0, 0.02],
  footR: [0.11, 0, 0.02],
});
const G = pose(S, {
  grip: [0.24, 1.2, 0.36],
  dir: [-1, 0.32, 0.18],
  lhand: [-0.1, 1.26, 0.4],
  hipY: -0.11,
  chestPitch: 0.1,
  chestYaw: 0.12,
  head: -0.04,
});
const DODGE_LOW = pose(S, { hipY: -0.24, chestPitch: 0.42, lean: 0.05, head: -0.3, grip: [0.28, 0.85, 0.1], dir: [0.3, 0.1, -1], gait: 1 });

const A1_WIND = pose(S, {
  grip: [0.32, 1.52, 0.06],
  dir: [0.45, 0.65, -0.4],
  lhand: [-0.2, 1.18, 0.34],
  chestYaw: -0.5,
  chestPitch: -0.04,
  hipYaw: -0.05,
  head: -0.02,
});
const A1_MID = pose(S, {
  grip: [0.02, 1.26, 0.56],
  dir: [-0.55, -0.05, 1],
  lhand: [-0.3, 1.05, 0.05],
  chestYaw: 0.12,
  chestPitch: 0.14,
  lean: 0.12,
  footL: [-0.14, 0, 0.36],
});
const A1_END = pose(A1_MID, {
  grip: [-0.3, 0.9, 0.42],
  dir: [-0.85, -0.5, 0.25],
  chestYaw: 0.52,
  chestPitch: 0.3,
  hipY: -0.12,
});
const A2_GATHER = pose(A1_END, { grip: [-0.32, 0.86, 0.3], dir: [-0.9, -0.35, 0.15], chestYaw: 0.58 });
const A2_MID = pose(A1_END, {
  grip: [0.02, 1.2, 0.56],
  dir: [0.2, 0.35, 1],
  chestYaw: 0.05,
  chestPitch: 0.12,
  hipY: -0.08,
  footL: [-0.14, 0, 0.3],
});
const A2_END = pose(A2_MID, { grip: [0.36, 1.55, 0.26], dir: [0.7, 0.7, -0.1], chestYaw: -0.48, chestPitch: -0.02, head: -0.02 });
const A3_WIND = pose(S, {
  grip: [0.04, 1.68, 0.02],
  dir: [0, 0.35, -1],
  two: 1,
  chestPitch: -0.2,
  chestYaw: 0,
  hipYaw: 0.05,
  hipY: -0.03,
  head: 0.05,
  footL: [-0.14, 0, 0.2],
});
const A3_MID = pose(A3_WIND, { grip: [0, 1.22, 0.55], dir: [0, 0.25, 1], chestPitch: 0.3, lean: 0.14, footL: [-0.14, 0, 0.42], hipY: -0.1 });
const A3_END = pose(A3_MID, { grip: [0, 0.8, 0.5], dir: [0, -0.65, 1], chestPitch: 0.55, hipY: -0.24, head: -0.2 });

const HIT = pose(S, {
  chestPitch: -0.32,
  head: 0.3,
  hipY: -0.05,
  bodyRoll: 0.08,
  grip: [0.42, 1.05, 0.05],
  dir: [0.6, 0.3, -0.4],
  lhand: [-0.35, 1.15, 0.1],
  footR: [0.16, 0, -0.35],
  lean: -0.06,
});
const GBREAK = pose(S, {
  hipY: -0.26,
  chestPitch: 0.5,
  head: 0.35,
  grip: [0.36, 0.7, 0.18],
  dir: [0.3, -0.9, 0.3],
  lhand: [-0.28, 0.8, 0.2],
  footR: [0.18, 0, -0.34],
});
const KNEEL = pose(S, {
  hipY: -0.46,
  chestPitch: 0.42,
  head: 0.4,
  footR: [0.17, 0, -0.52],
  footL: [-0.15, 0, 0.26],
  grip: [0.35, 0.5, 0.25],
  dir: [0.25, -0.9, 0.3],
  lhand: [-0.25, 0.55, 0.3],
  gait: 0,
});
const DOWN = pose(KNEEL, { bodyPitch: 1.42, rootY: 0.14, chestPitch: 0.2, head: 0.1, grip: [0.5, 0.9, 0.3], dir: [0.8, 0, 0.5], lhand: [-0.4, 0.95, 0.35] });
const JUMP = pose(S, { footL: [-0.14, 0.3, 0.12], footR: [0.16, 0.2, -0.12], hipY: -0.02, chestPitch: 0.2, gait: 0 });

// Finisher: left hand seizes, sword pulled back, then driven in, held, drawn out, flicked clean.
const F_GRAB = pose(S, {
  lhand: [0.0, 1.32, 0.62],
  grip: [0.27, 1.28, -0.18],
  dir: [-0.05, 0.02, 1],
  chestYaw: -0.55,
  hipYaw: -0.1,
  chestPitch: 0.12,
  head: 0,
  hipY: -0.13,
  lean: 0.12,
  footL: [-0.14, 0, 0.36],
  footR: [0.18, 0, -0.26],
});
const F_PLUNGE = pose(F_GRAB, {
  grip: [0.05, 1.08, 0.78],
  dir: [0, -0.2, 1],
  chestYaw: 0.22,
  hipYaw: 0.1,
  hipY: -0.22,
  lean: 0.34,
  chestPitch: 0.4,
  footL: [-0.14, 0, 0.62],
  footR: [0.18, 0, -0.38],
  lhand: [-0.02, 1.2, 0.68],
});
const F_OUT = pose(F_PLUNGE, { grip: [0.3, 1.2, 0.1], dir: [0.2, 0.1, 1], chestYaw: -0.3, lean: 0.04, lhand: [-0.26, 1.0, 0.15] });
const F_FLICK = pose(S, { grip: [0.48, 0.98, 0.3], dir: [0.65, -0.62, 0.35], chestYaw: -0.4, chestPitch: 0.08, lhand: [-0.26, 0.98, 0.1] });
const F_REST = pose(S, { grip: [0.3, 0.9, 0.2], dir: [0.35, -0.7, 0.6], chestPitch: 0.05, head: -0.02, hipY: -0.03 });

// Charged cut: blade drawn high behind the head, trembling, then a long two-handed drop.
const C_WIND = pose(A3_WIND, { grip: [0.08, 1.74, -0.1], dir: [0.1, 0.25, -1], chestPitch: -0.26, chestYaw: -0.2, hipY: -0.08, footL: [-0.14, 0, 0.3], tremble: 0.6 });
const C_CUT = pose(A3_MID, { grip: [0, 1.16, 0.6], dir: [0, 0.1, 1], chestPitch: 0.36, lean: 0.2, footL: [-0.14, 0, 0.5], tremble: 0 });
const C_END = pose(A3_END, { grip: [0, 0.72, 0.52], dir: [0, -0.75, 0.9], chestPitch: 0.6, hipY: -0.28, footL: [-0.14, 0, 0.5] });
// Jump attack: tucked overhead in the air, cut down on the way to the roof.
const JA_UP = pose(JUMP, { grip: [0.05, 1.7, 0.0], dir: [0, 0.4, -1], two: 1, chestPitch: -0.24, footL: [-0.14, 0.34, 0.1], footR: [0.16, 0.26, -0.14] });
const JA_CUT = pose(JUMP, { grip: [0, 1.0, 0.62], dir: [0, -0.3, 1], two: 1, chestPitch: 0.45, lean: 0.12, footL: [-0.14, 0.16, 0.26], footR: [0.16, 0.1, -0.12] });
const JA_LAND = pose(A3_END, { hipY: -0.26, footL: [-0.14, 0, 0.3], footR: [0.16, 0, -0.2] });
// Kick off his body: right foot driven forward at chest height, body leaning back.
const KICK = pose(JUMP, { footR: [0.12, 0.95, 0.62], footL: [-0.14, 0.28, -0.05], chestPitch: -0.28, head: 0.12, lean: -0.1, grip: [0.36, 1.12, -0.1], dir: [0.5, 0.1, -1] });
// Gourd: left hand up to the mouth, head tipped back, sword lowered at the side.
const DRINK_UP = pose(S, { lhand: [-0.03, 1.56, 0.16], head: -0.32, chestPitch: -0.06, grip: [0.3, 0.92, 0.12], dir: [0.3, -0.6, 0.7] });
const DRINK = pose(DRINK_UP, { head: -0.42, chestPitch: -0.1 });
// Mikiri: step onto the thrust, left foot stamps the blade to the roof, sword raised to cut.
const MK_STEP = pose(S, { footL: [-0.1, 0.32, 0.46], hipY: -0.04, chestPitch: 0.1, grip: [0.32, 1.45, -0.05], dir: [0.3, 0.8, -0.5], lhand: [-0.3, 1.1, 0.3] });
const MK_STOMP = pose(S, { footL: [-0.06, 0, 0.62], footR: [0.16, 0, -0.2], hipY: -0.2, lean: 0.12, chestPitch: 0.34, head: -0.25, grip: [0.3, 1.5, 0.0], dir: [0.4, 0.8, -0.4], lhand: [-0.25, 0.95, 0.45] });
// Thrown: lifted by the collar, then slammed down.
const LIFTED = pose(HIT, { rootY: 0.38, bodyPitch: -0.3, footL: [-0.14, 0.2, 0.12], footR: [0.16, 0.14, -0.1], gait: 0, head: 0.35 });

const k = (t: number, p: Pose, stop = false) => ({ t, p, stop });

export class Shinobi extends Character {
  readonly clips: Record<string, Clip>;
  protected readonly events = PROCEDURAL_PLAYER;

  constructor() {
    const clips: Record<string, Clip> = {
      idle: new Clip("idle", [k(0, S), k(1.3, S2), k(2.6, S)], true),
      run: new Clip("run", [k(0, RUN), k(0.5, pose(RUN, { chestPitch: 0.4 })), k(1, RUN)], true),
      guard: new Clip("guard", [k(0, G), k(1.2, pose(G, { hipY: -0.12 })), k(2.4, G)], true),
      deflect: new Clip("deflect", [
        k(0, G),
        k(0.04, pose(G, { grip: [0.16, 1.32, 0.52], dir: [-1, 0.55, 0.35], chestPitch: 0.16, lean: 0.07 })),
        k(0.3, G),
      ]),
      block: new Clip("block", [k(0, G), k(0.05, pose(G, { grip: [0.24, 1.18, 0.26], chestPitch: -0.04, lean: -0.05 })), k(0.32, G)]),
      dodge: new Clip("dodge", [k(0, S), k(0.09, DODGE_LOW), k(0.26, DODGE_LOW), k(0.42, S)]),
      attack1: new Clip("attack1", [k(0, S), k(0.1, A1_WIND, true), k(0.2, A1_MID), k(0.28, A1_END), k(0.6, S)]),
      attack2: new Clip("attack2", [k(0, A1_END), k(0.08, A2_GATHER, true), k(0.18, A2_MID), k(0.27, A2_END), k(0.6, S)]),
      attack3: new Clip("attack3", [k(0, S), k(0.2, A3_WIND, true), k(0.3, A3_MID), k(0.38, A3_END), k(0.55, A3_END), k(0.9, S)]),
      hit: new Clip("hit", [k(0, S), k(0.14, HIT), k(0.45, S)]),
      guardbreak: new Clip("guardbreak", [k(0, G), k(0.12, GBREAK), k(1.0, pose(GBREAK, { hipY: -0.22 })), k(1.3, S)]),
      death: new Clip("death", [k(0, HIT), k(0.45, KNEEL), k(1.1, pose(KNEEL, { chestPitch: 0.6 })), k(1.7, DOWN), k(3, DOWN)]),
      jump: new Clip("jump", [k(0, S), k(0.15, JUMP), k(0.5, JUMP)]),
      finisher: new Clip("finisher", [
        k(0, S),
        k(0.3, F_GRAB, true),
        k(0.44, F_PLUNGE),
        k(1.25, pose(F_PLUNGE, { lean: 0.24 })),
        k(1.55, F_OUT),
        k(1.85, F_FLICK),
        k(2.5, F_REST),
      ]),
      victory: new Clip("victory", [k(0, F_REST), k(1.5, pose(F_REST, { chestPitch: 0.08 })), k(3, F_REST)], true),
      attackC: new Clip("attackC", [k(0, A1_END), k(0.2, C_WIND), k(0.36, pose(C_WIND, { grip: [0.08, 1.76, -0.12] }), true), k(0.48, C_CUT), k(0.58, C_END), k(0.7, C_END), k(1.0, S)]),
      jumpAtk: new Clip("jumpAtk", [k(0, JUMP), k(0.12, JA_UP, true), k(0.26, JA_CUT), k(0.38, pose(JA_CUT, { grip: [0, 0.8, 0.55], dir: [0, -0.7, 0.8] })), k(0.6, pose(JA_CUT, { grip: [0, 0.8, 0.55], dir: [0, -0.7, 0.8] }))]),
      jumpLand: new Clip("jumpLand", [k(0, JA_LAND), k(0.3, S)]),
      kick: new Clip("kick", [k(0, JUMP), k(0.07, KICK), k(0.3, JUMP)]),
      heal: new Clip("heal", [k(0, S), k(0.3, DRINK_UP), k(0.45, DRINK), k(0.72, DRINK), k(1.0, S)]),
      mikiri: new Clip("mikiri", [k(0, DODGE_LOW), k(0.08, MK_STEP), k(0.16, MK_STOMP), k(0.62, pose(MK_STOMP, { hipY: -0.18 })), k(1.05, S)]),
      revive: new Clip("revive", [k(0, DOWN), k(0.55, KNEEL), k(1.1, pose(KNEEL, { chestPitch: 0.2, head: -0.1 })), k(1.45, S2), k(1.7, S)]),
      thrown: new Clip("thrown", [k(0, HIT), k(0.4, LIFTED), k(0.62, pose(LIFTED, { rootY: 0.5 })), k(0.74, DOWN), k(1.15, DOWN), k(1.5, KNEEL), k(1.9, S)]),
      deathblow: new Clip("deathblow", [k(0, S), k(0.2, F_GRAB, true), k(0.31, F_PLUNGE), k(0.7, pose(F_PLUNGE, { lean: 0.26 })), k(0.9, F_OUT), k(1.15, F_FLICK), k(1.45, S)]),
      // Abilities: a throw from the off hand, igniting the blade, the crow step's vanish.
      tool: new Clip("tool", [k(0, S), k(0.08, G), k(0.2, G), k(0.45, S)]),
      curse: new Clip("curse", [k(0, S), k(0.12, G), k(0.42, G), k(0.6, S)]),
      crow: new Clip("crow", [k(0, S), k(0.09, DODGE_LOW), k(0.3, DODGE_LOW), k(0.42, S)]),
    };
    super(SHINOBI_DIMS, clips.idle, 0xbfd6ff, 1.1);
    this.clips = clips;
    this.build();
  }

  private parts!: ShinobiParts;

  /** `scarfWrap`: the scarf coils round the throat (chest space), for a skinned body's neck. */
  part(name: string): THREE.Object3D | null {
    if (name !== "scarfWrap") return super.part(name);
    const g = new THREE.Group();
    for (const c of this.rig.chest.children) if (c.userData.scarfWrap) g.add(c.clone());
    return g;
  }

  private build(): void {
    const r = this.rig;
    this.parts = buildShinobi(r, SHINOBI_DIMS);
    // ---------------------------------------------------------------- scarf tails (cloth)
    for (let t = 0; t < 2; t++) {
      const w = 3;
      const h = t === 0 ? 16 : 11;
      const cloth = new Cloth(w, h, 0.07, 0.08, this.parts.scarfMat);
      cloth.windScale = 1.4;
      cloth.gravity = 5.5;
      cloth.damping = 0.975;
      cloth.hangDir.set(0, -0.6, -0.8).normalize();
      const pins: THREE.Object3D[] = [];
      for (let j = 0; j < w; j++) {
        const a = new THREE.Object3D();
        a.position.set((j - 1) * 0.05 + (t === 0 ? -0.04 : 0.055), 0.45 - t * 0.02, -0.1);
        r.chest.add(a);
        pins.push(a);
      }
      this.cloths.push({ cloth, pins });
    }
    for (let i = 0; i < 5; i++) this.colliders.push({ c: new THREE.Vector3(), r: 0.1 });
    r.root.traverse((o) => {
      o.castShadow = true;
    });
  }

  protected afterRig(): void {
    const r = this.rig;
    const two = this.anim.out[I.two] > 0.5;
    this.parts.lGrip.visible = two;
    this.parts.lFist.visible = !two;
    // Tunic panels swing with the thighs.
    for (const f of this.parts.flaps) {
      let kick = 0;
      for (let i = 0; i < 2; i++) {
        const knee = r.kneeW[i];
        const dz = (knee.x - r.hipsW.x) * Math.sin(r.yaw) + (knee.z - r.hipsW.z) * Math.cos(r.yaw);
        kick = Math.max(kick, dz * Math.cos(f.ang));
      }
      f.g.rotation.x = Math.max(-0.1, Math.min(0.9, kick * 1.6)) + 0.04;
    }
  }

  protected updateColliders(): void {
    const r = this.rig;
    const c = this.colliders;
    c[0].c.copy(r.chestW);
    c[0].r = 0.19;
    c[1].c.copy(r.hipsW);
    c[1].r = 0.2;
    c[2].c.copy(r.kneeW[0]);
    c[2].r = 0.14;
    c[3].c.copy(r.kneeW[1]);
    c[3].r = 0.14;
    c[4].c.copy(r.headW).y += 0.1;
    c[4].r = 0.12;
  }
}
