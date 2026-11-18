/**
 * A Mixamo-rigged body driven by an AnimationMixer, behind the same Fighter interface as the
 * procedural rig. Loads the converted GLB (GLTFLoader + meshopt) or, with CHARS_FBX=1 on the dev
 * server, the raw Mixamo FBX files from assets/mixamo (FBXLoader).
 *
 * One action per clip, LoopRepeat or LoopOnce + clampWhenFinished, crossfaded by hand (weights
 * always sum to 1), the mixer stepped with game-scaled time so hitstop and slow-mo apply. One-shot
 * moves run on the gameplay clock: the procedural rig's timeline (the tuned combat) drives them and
 * the clip is time-warped so its own wind-up / cut / contact / plunge land on those times. The
 * hidden procedural rig (`ref`, set by FighterSlot) supplies the hurt capsule and the reference
 * blade the skinned blade is steered onto in hit windows, rebounds and recoil (arm + spine IK).
 *
 * Bone names are normalized (mixamorig:Hips / mixamorig1_Hips / mixamorigHips → Hips) on the
 * skeleton and in every track, the Hips' horizontal motion is stripped (root motion; gameplay moves
 * the fighter), and the katana plus reused procedural parts hang in bone sockets.
 */
import * as THREE from "three";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { Trail } from "../fx/Trail";
import { mergeTimelines, offsetTimeline, resolveEvents, type ClipEvents, type Segment, type Timeline } from "./animEvents";
import type { Character } from "./Character";
import type { Cloth, Sphere } from "./Cloth";
import type { Fighter, FighterRig } from "./Fighter";
import type { ClipSpec, SkinnedConfig, Socket } from "./skinnedConfig";

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _ax = new THREE.Vector3();
const [_g0, _g1, _g2, _g3, _g4, _g5, _g6] = Array.from({ length: 7 }, () => new THREE.Vector3());
const [_gq, _gpq, _gbq] = Array.from({ length: 3 }, () => new THREE.Quaternion());
const _gi = new THREE.Quaternion();
const _avoidT = new THREE.Vector3();
/** Guard IK: full weight this long after the contact, then fades out (as the procedural rig). */
const GUARD_HOLD = 0.1;
/** Guard ⇄ guard-walk fade (the leg layer fades at the same rate so leg weights sum to 1). */
const LEG_FADE = 0.2;
/** Largest speed-up of a clip's lead-in / recovery when fitting it to the gameplay clock. */
const WARP_K = 1.6;
const GUARD_OUT = 0.18;

/** mixamorig:Hips, mixamorig1_Hips, mixamorigHips, Armature|mixamorig:Hips → Hips */
export function normalizeBone(name: string): string {
  return name.replace(/^.*\|/, "").replace(/^mixamorig\d*[:_]?/i, "");
}

/** Blender / FBX clip names → lower-case basenames ("Armature|Attack1" → "attack1"). */
export function normalizeClip(name: string): string {
  return name.replace(/^.*\|/, "").trim().toLowerCase().replace(/\s+/g, "_");
}

export interface SkinnedFiles {
  glb?: string;
  fbx?: Record<string, string>;
}

/**
 * A one-shot move on the gameplay clock: the procedural body's timeline (the tuned combat timings)
 * drives it, and the clip(s) are time-warped piecewise-linearly so their own events (wind-up
 * peak, hit start / contact / end, plunge, cues) land exactly on the gameplay events.
 * `v` is "virtual clip time": the segments' clip ranges laid end to end.
 */
interface Warp {
  segs: { clip: string; a: number; b: number; off: number }[];
  g: number[];
  v: number[];
}

class SkinnedRig implements FighterRig {
  readonly root = new THREE.Group();
  readonly hiltW = new THREE.Vector3();
  readonly tipW = new THREE.Vector3();
  readonly prevHiltW = new THREE.Vector3();
  readonly prevTipW = new THREE.Vector3();
  readonly chestW = new THREE.Vector3();
  readonly headW = new THREE.Vector3();
  readonly hipsW = new THREE.Vector3();
  readonly kneeW = [new THREE.Vector3(), new THREE.Vector3()];
  readonly vel = new THREE.Vector3();
  yaw = 0;
  onStep: ((foot: number, speed: number) => void) | null = null;
  first = true;

  /** Hurt capsule heights (above the root) and radius, taken from the procedural body's stance. */
  capY = [0.4, 1.45];

  constructor(public r: number) {}

  /**
   * Hurt capsule: the procedural rig's standing heights and radius (the gameplay-tuned target
   * volume: every reach and i-frame number was tuned against it), leaning with the hips and head.
   */
  /** The procedural rig running the same moves: its capsule is the tuned hurt volume. */
  ref: FighterRig | null = null;

  capsule(a: THREE.Vector3, b: THREE.Vector3): number {
    if (this.ref) return this.ref.capsule(a, b);
    const o = this.root.position;
    const lean = (p: THREE.Vector3, out: THREE.Vector3, y: number) => {
      out.set(p.x - o.x, 0, p.z - o.z);
      if (out.lengthSq() > 0.12 * 0.12) out.setLength(0.12);
      return out.add(o).setY(o.y + y);
    };
    lean(this.hipsW, a, this.capY[0]);
    lean(this.headW, b, this.capY[1]);
    return this.r;
  }


  resetTrail(): void {
    this.first = true;
  }
}

interface Seq {
  plan: Segment[];
  i: number;
  /** Attack time at which each segment starts, and its clip-time range. */
  starts: number[];
  ranges: [number, number][];
  holdLeft: number;
  holdDone: boolean;
}

export class SkinnedCharacter implements Fighter {
  readonly kind = "skinned" as const;
  readonly rig: SkinnedRig;
  readonly trail: Trail;
  readonly mixer: THREE.AnimationMixer;
  readonly clips = new Map<string, THREE.AnimationClip>();
  private readonly model: THREE.Object3D;
  private readonly bones = new Map<string, THREE.Bone>();
  private readonly actions = new Map<string, THREE.AnimationAction[]>();
  /**
   * Actions fading out, faded by hand from the weight they had (three's crossFadeTo restarts a
   * fade-out from weight 1, so a second switch inside a fade popped). The current action takes the
   * rest, so weights always sum to 1 (no blend toward the bind pose).
   */
  private readonly fading = new Map<THREE.AnimationAction, { w0: number; t: number; dur: number }>();
  private cur: THREE.AnimationAction | null = null;
  private logical = "idle";
  private loco = "";
  private seq: Seq | null = null;
  private readonly swordSocket: THREE.Object3D;
  private readonly cloths: { cloth: Cloth; pins: THREE.Object3D[] }[] = [];
  private readonly colliders: Sphere[] = [];
  private readonly simPos = new THREE.Vector3();
  private hold = false;
  private held = 0;
  private rewound = 0;
  private lastDt = 0;
  private bounceT = -1;
  private avoid = false;
  private avoidW = 0;
  private guardTarget: THREE.Vector3 | null = null;
  private footPrev = 0;
  private gourd: THREE.Object3D | null = null;
  private readonly source: Character;
  /** The procedural rig running the same move (set by FighterSlot): reference blade for hit windows. */
  private refBody: Fighter | null = null;
  get ref(): Fighter | null {
    return this.refBody;
  }
  set ref(f: Fighter | null) {
    this.refBody = f;
    this.rig.ref = f?.rig ?? null;
  }
  private readonly warps = new Map<string, Warp | null>();
  private warp: Warp | null = null;
  private tau = 0;
  private segI = -1;

  /** Base fresnel rim (cfg.rim) and the live rim the shader reads (base + glow). */
  private readonly rimBase = new THREE.Color();
  readonly rimColor = new THREE.Color();
  readonly glowBody = { value: 0 };

  /** Glow over the body: `color` × `k` added to the rim, `body` spreads it from the edges inward. */
  setGlow(color: THREE.Color | null, k = 0, body = 0): void {
    this.rimColor.copy(this.rimBase);
    if (color && k > 0) this.rimColor.r += color.r * k, this.rimColor.g += color.g * k, this.rimColor.b += color.b * k;
    this.glowBody.value = color && k > 0 ? body : 0;
  }

  private constructor(
    readonly cfg: SkinnedConfig,
    model: THREE.Object3D,
    clips: THREE.AnimationClip[],
    source: Character,
  ) {
    this.source = source;
    if (cfg.rim) this.rimBase.set(cfg.rim.color).multiplyScalar(cfg.rim.strength);
    this.rimColor.copy(this.rimBase);
    this.rig = new SkinnedRig(cfg.capsuleR);
    {
      const pa = new THREE.Vector3();
      const pb = new THREE.Vector3();
      const sr = source.rig;
      this.rig.r = sr.capsule(pa, pb);
      this.rig.capY = [pa.y - sr.root.position.y, pb.y - sr.root.position.y];
    }
    this.trail = new Trail(cfg.trail.color, cfg.trail.intensity);
    this.model = model;
    model.traverse((o) => {
      if ((o as THREE.Bone).isBone) {
        o.name = normalizeBone(o.name);
        this.bones.set(o.name, o as THREE.Bone);
      }
      if ((o as THREE.Mesh).isMesh) {
        o.castShadow = true;
        // Skinned bounds follow the bind pose: animated limbs would pop out of the frustum.
        o.frustumCulled = false;
        if (cfg.rim) for (const m of [(o as THREE.Mesh).material].flat()) addRim(m as THREE.MeshStandardMaterial, this.rimColor, this.glowBody);
      }
    });
    // Scale the bind pose to the character's height; face +Z.
    const box = new THREE.Box3().setFromObject(model);
    const h = box.max.y - box.min.y;
    if (h > 1e-3) model.scale.multiplyScalar(cfg.height / h);
    model.rotation.y += cfg.yawOffset;
    model.position.y -= box.min.y * (h > 1e-3 ? cfg.height / h : 1);
    this.rig.root.add(model);
    this.rig.root.updateMatrixWorld(true);

    const hips = this.bones.get(cfg.bones.hips);
    const rest = hips ? hips.position.clone() : new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    if (hips?.parent) up.applyQuaternion(hips.parent.getWorldQuaternion(new THREE.Quaternion()).invert()).normalize();
    const hidden = new Set(cfg.hide ?? []);
    for (const b of hidden) this.bones.get(b)?.scale.setScalar(1e-3);
    // Whole meshes replaced by reused parts (the Paladin's own helmet under the kabuto).
    if (cfg.hideMeshes?.length) model.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && cfg.hideMeshes!.includes(o.name)) o.visible = false;
    });
    for (const c of clips) {
      const clip = c.clone();
      clip.name = normalizeClip(c.name);
      clip.tracks = clip.tracks.filter((t) => !(t.name.endsWith(".scale") && hidden.has(normalizeBone(THREE.PropertyBinding.parseTrackName(t.name).nodeName ?? ""))));
      for (const t of clip.tracks) {
        const p = THREE.PropertyBinding.parseTrackName(t.name);
        const bone = normalizeBone(p.nodeName ?? "");
        t.name = `${bone}.${p.propertyName}${p.propertyIndex !== undefined ? `[${p.propertyIndex}]` : ""}`;
        // Root motion: gameplay moves the fighter; keep only the Hips' vertical motion. "Vertical"
        // is world up in the Hips' parent frame (Mixamo armatures are Z-up under a -90° X turn).
        if (bone === cfg.bones.hips && p.propertyName === "position") {
          const v = t.values;
          for (let i = 0; i < v.length; i += 3) {
            const k = (v[i] - rest.x) * up.x + (v[i + 1] - rest.y) * up.y + (v[i + 2] - rest.z) * up.z;
            v[i] = rest.x + up.x * k;
            v[i + 1] = rest.y + up.y * k;
            v[i + 2] = rest.z + up.z * k;
          }
        }
      }
      // Turn-in-place clips rotate the Hips 90°; gameplay already turns the fighter, so keep only
      // the stepping (the Hips' twist about up, relative to the first frame, is removed).
      if (/^turn_/.test(clip.name))
        for (const t of clip.tracks) {
          if (!t.name.startsWith(cfg.bones.hips + ".quaternion")) continue;
          const v = t.values;
          const q0i = new THREE.Quaternion(v[0], v[1], v[2], v[3]).invert();
          const q = new THREE.Quaternion();
          const d = new THREE.Quaternion();
          const tw = new THREE.Quaternion();
          for (let i = 0; i < v.length; i += 4) {
            q.set(v[i], v[i + 1], v[i + 2], v[i + 3]);
            d.multiplyQuaternions(q, q0i);
            const k = d.x * up.x + d.y * up.y + d.z * up.z;
            tw.set(up.x * k, up.y * k, up.z * k, d.w).normalize();
            q.premultiply(tw.invert());
            v[i] = q.x;
            v[i + 1] = q.y;
            v[i + 2] = q.z;
            v[i + 3] = q.w;
          }
        }
      this.clips.set(clip.name, clip);
    }
    // Guarding on the move: the guard pose on the upper body over the walk / strafe legs.
    const LOWER = /^(Hips|(Left|Right)(UpLeg|Leg|Foot|ToeBase|Toe_End))\./;
    const g = cfg.clips.guard?.clip;
    const gc = g ? this.clips.get(g) : undefined;
    if (gc) {
      const up2 = new THREE.AnimationClip(`${g}__upper`, gc.duration, gc.tracks.filter((t) => !LOWER.test(t.name)));
      this.clips.set(up2.name, up2);
      const L = cfg.locomotion;
      for (const n of [L.walk, L.back, L.left, L.right]) {
        const c = n ? this.clips.get(n) : undefined;
        if (c) this.clips.set(`${n}__lower`, new THREE.AnimationClip(`${n}__lower`, c.duration, c.tracks.filter((t) => LOWER.test(t.name))));
      }
    }
    this.mixer = new THREE.AnimationMixer(model);

    // Katana (and reused procedural parts) in bone sockets, in world metres.
    this.swordSocket = this.socket(cfg.sword);
    this.fitSword();
    this.sockPos.copy(this.swordSocket.position);
    this.sockQ.copy(this.swordSocket.quaternion);
    const sword = source.part("sword");
    if (sword) for (const c of sword.children) this.swordSocket.add(c.clone());
    for (const a of cfg.attach) {
      const p = source.part(a.part);
      if (!p) continue;
      const s = this.socket(a);
      const g = p.clone();
      g.position.set(0, 0, 0);
      g.rotation.set(0, 0, 0);
      if (cfg.clothTint !== undefined && a.part === "scarfWrap")
        g.traverse((m) => {
          if ((m as THREE.Mesh).isMesh) (m as THREE.Mesh).material = tinted((m as THREE.Mesh).material as THREE.MeshStandardMaterial, cfg.clothTint!);
        });
      s.add(g);
    }
    for (const c of cfg.cloth) {
      const src = source.cloths[c.index];
      if (!src) continue;
      const s = this.socket(c.socket);
      const pins = src.pins.map((p) => {
        const o = new THREE.Object3D();
        o.position.copy(p.position);
        s.add(o);
        return o;
      });
      const cl = src.cloth.clone();
      if (cfg.clothTint !== undefined) cl.mesh.material = tinted(cl.mesh.material as THREE.MeshStandardMaterial, cfg.clothTint);
      this.cloths.push({ cloth: cl, pins });
    }
    if (cfg.gourd) {
      this.gourd = this.socket(cfg.gourd);
      this.gourd.add(makeGourd());
    }
    for (let i = 0; i < 5; i++) this.colliders.push({ c: new THREE.Vector3(), r: 0.12 });
    this.rig.root.traverse((o) => (o.castShadow = true));
    // Blade analysis + time warps up front (they pose the mixer; never mid-fight).
    for (const n of new Set([...Object.keys(cfg.clips), ...Object.keys(cfg.plans ?? {})])) {
      this.warpFor(n);
      const d = cfg.clips[n]?.dir;
      for (const v of [...(cfg.clips[n]?.variants ?? []), ...(d ? [d.fwd, d.back, d.left, d.right] : [])]) if (this.clips.has(v)) this.warpFor(n, v);
      this.warpFor(n, this.spec(n).clip);
    }
    this.play("idle", 0);
    this.step(0, new THREE.Vector3(), 0);
  }

  /** Load a body; null (and a console warning) if files are missing or unusable. */
  static async load(cfg: SkinnedConfig, files: SkinnedFiles, source: Character): Promise<SkinnedCharacter | null> {
    try {
      let model: THREE.Object3D;
      const clips: THREE.AnimationClip[] = [];
      if (files.glb) {
        const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(new URL(import.meta.env.BASE_URL + files.glb, document.baseURI).href);
        model = gltf.scene;
        clips.push(...gltf.animations);
      } else if (files.fbx && files.fbx[cfg.modelFile]) {
        const fbx = new FBXLoader();
        model = await fbx.loadAsync(files.fbx[cfg.modelFile]);
        for (const [name, url] of Object.entries(files.fbx)) {
          const src = name === cfg.modelFile ? model : await fbx.loadAsync(url);
          const a = src.animations[0];
          if (a) {
            // Mixamo names every take "mixamo.com": the file name is the clip name.
            a.name = name;
            clips.push(a);
          }
          if (src !== model)
            src.traverse((o) => {
              const m = o as THREE.Mesh;
              if (m.isMesh) {
                m.geometry.dispose();
                for (const mt of Array.isArray(m.material) ? m.material : [m.material]) mt.dispose();
              }
            });
        }
      } else return null;
      return SkinnedCharacter.fromParts(cfg, model, clips, source);
    } catch (e) {
      console.warn(`[chars] ${cfg.name}: could not load (${(e as Error).message}) — keeping the procedural body`);
      return null;
    }
  }

  /** Validate required clips and build; null (with a warning) if any are missing. */
  static fromParts(cfg: SkinnedConfig, model: THREE.Object3D, clips: THREE.AnimationClip[], source: Character): SkinnedCharacter | null {
    const names = new Set(clips.map((c) => normalizeClip(c.name)));
    // ?anyclips (debug): accept a body with required clips missing, to fit sockets while files arrive.
    const loose = new URLSearchParams(location.search).has("anyclips");
    const missing = loose ? [] : cfg.required.filter((n) => !names.has(n));
    if (missing.length) {
      console.warn(`[chars] ${cfg.name}: missing clips ${missing.join(", ")} — keeping the procedural body`);
      return null;
    }
    return new SkinnedCharacter(cfg, model, clips, source);
  }

  /** Bone lookup by normalized name (debug / tests). */
  bone(name: string): THREE.Bone | undefined {
    return this.bones.get(name);
  }

  // ------------------------------------------------------------------ sockets

  private socket(s: Socket): THREE.Object3D {
    const bone = this.bones.get(s.bone);
    const o = new THREE.Group();
    (bone ?? this.model).add(o);
    this.rig.root.updateMatrixWorld(true);
    // Undo the bone's world scale (Mixamo armatures are often ×0.01) so offsets are metres.
    const ws = (bone ?? this.model).getWorldScale(_v).x || 1;
    o.scale.setScalar(s.scale / ws);
    o.position.set(s.offset[0] / ws, s.offset[1] / ws, s.offset[2] / ws);
    o.rotation.set(s.rot[0], s.rot[1], s.rot[2]);
    return o;
  }

  /** `sword.auto`: fit the katana to the fist (pinky → index knuckle axis, edge toward the knuckles). */
  private fitSword(): void {
    const s = this.cfg.sword;
    const a = s.auto;
    const bone = (names: string[]) => names.map((n) => this.bones.get(n)).find((b) => !!b);
    const hand = this.bones.get(s.bone);
    const index = bone(["RightHandIndex1", "index_01_r"]);
    const middle = bone(["RightHandMiddle1", "middle_01_r"]);
    const pinky = bone(["RightHandPinky1", "pinky_01_r", "RightHandRing1", "ring_01_r"]);
    const clip = a && this.clips.get(this.spec(a.clip).clip);
    if (!a || !hand || !index || !middle || !pinky || !clip) return;
    const act = this.mixer.clipAction(clip);
    act.play();
    act.time = a.t * clip.duration;
    this.mixer.update(0);
    this.rig.root.updateMatrixWorld(true);
    const w = (b: THREE.Object3D) => b.getWorldPosition(new THREE.Vector3());
    const pw = w(hand);
    const pi = w(index);
    const pm = w(middle);
    const pp = w(pinky);
    const dir = pi.clone().sub(pp).normalize();
    const edge = pm.clone().sub(pw);
    edge.addScaledVector(dir, -edge.dot(dir)).normalize();
    const x = new THREE.Vector3().crossVectors(dir, edge);
    const qW = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, dir, edge));
    qW.multiply(_q.setFromAxisAngle(_ax.set(0, 1, 0), a.roll));
    // Tilt the blade toward its edge (sword-local +Z) about the flat's normal (local X).
    if (a.tilt) qW.multiply(_q.setFromAxisAngle(_ax.set(1, 0, 0), a.tilt));
    const knuckles = pi.clone().add(pm).add(pp).multiplyScalar(1 / 3);
    const grip = pw.clone().lerp(knuckles, a.palm).addScaledVector(dir, a.lift).addScaledVector(edge, a.side);
    // World pose → the hand bone's frame (the socket keeps its uniform scale). Before `stop()`:
    // the mixer restores the bind pose once no action drives the bones.
    this.swordSocket.position.copy(grip.applyMatrix4(hand.matrixWorld.clone().invert()));
    this.swordSocket.quaternion.copy(hand.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(qW));
    act.stop();
  }

  // ------------------------------------------------------------------ clips

  listClips(): { name: string; dur: number; loop: boolean }[] {
    return [...this.clips.values()].map((c) => ({ name: c.name, dur: c.duration, loop: Object.values(this.cfg.clips).some((s) => s.clip === c.name && s.loop) }));
  }

  private readonly turn = new Map<string, number>();

  /** `variants`: the next present clip in turn (deterministic, so replays and tests repeat). */
  private variant(name: string): ClipSpec {
    const s = this.spec(name);
    const dir = this.cfg.clips[name]?.dir;
    if (dir) {
      const v = this.rig.vel;
      const cy = Math.cos(this.rig.yaw);
      const sy = Math.sin(this.rig.yaw);
      const fwd = v.x * sy + v.z * cy;
      const side = v.x * cy - v.z * sy;
      const c = Math.hypot(fwd, side) < 0.3 ? dir.back : Math.abs(side) > Math.abs(fwd) ? (side > 0 ? dir.left : dir.right) : fwd > 0 ? dir.fwd : dir.back;
      return this.clips.has(c) ? { ...s, clip: c } : s;
    }
    const all = [s.clip, ...(this.cfg.clips[name]?.variants ?? []).filter((c) => this.clips.has(c))];
    if (all.length < 2) return s;
    const i = this.turn.get(name) ?? 0;
    this.turn.set(name, (i + 1) % all.length);
    return { ...s, clip: all[i] };
  }

  private spec(name: string): ClipSpec {
    const s = this.cfg.clips[name] ?? (this.clips.has(name) ? { clip: name } : null);
    if (s && this.clips.has(s.clip)) return s;
    const alt = s?.alt?.find((c) => this.clips.has(c));
    if (s && alt) return { ...s, clip: alt };
    return this.cfg.clips.idle ?? { clip: "idle", loop: true };
  }

  private speedOf(s: ClipSpec): number {
    const c = this.clips.get(s.clip);
    if (s.fit && c) return c.duration / s.fit;
    return s.speed ?? 1;
  }

  /** An action for `clip` that isn't `avoid` (a clip re-entered while fading gets a twin). */
  private action(clip: string, avoid: THREE.AnimationAction | null): THREE.AnimationAction {
    let list = this.actions.get(clip);
    if (!list) this.actions.set(clip, (list = []));
    // Never restart an action that is still fading out (its weight would jump).
    let a = list.find((x) => x !== avoid && !this.fading.has(x));
    if (!a) {
      const c = this.clips.get(clip)!;
      a = this.mixer.clipAction(list.length ? Object.assign(c.clone(), { name: `${c.name}#${list.length}` }) : c);
      list.push(a);
    }
    return a;
  }

  private fadeFor(from: string, to: string, fallback: number): number {
    const f = this.cfg.fades;
    return f[`${from}>${to}`] ?? f[`*>${to}`] ?? f[`${from}>*`] ?? fallback;
  }

  private start(spec: ClipSpec, fade: number, time: number): void {
    const next = this.action(spec.clip, this.cur);
    const clip = next.getClip();
    // Everything still showing fades out from where it is now.
    const out = [...this.fading.keys()];
    if (this.cur && this.cur !== next && !this.fading.has(this.cur)) out.push(this.cur);
    for (const a of out) {
      if (a === next) continue;
      const w0 = a.getEffectiveWeight();
      if (fade > 0 && w0 > 1e-3) this.fading.set(a, { w0, t: 0, dur: fade });
      else {
        a.stop();
        this.fading.delete(a);
      }
    }
    this.fading.delete(next);
    next.enabled = true;
    next.setLoop(spec.loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    next.clampWhenFinished = !spec.loop;
    next.reset();
    next.setEffectiveTimeScale(this.speedOf(spec));
    next.time = spec.atEnd ? clip.duration : Math.min(time, clip.duration);
    next.play();
    this.cur = next;
    this.updateFades(0);
  }

  private updateFades(dt: number): void {
    let sum = 0;
    for (const [a, f] of this.fading) {
      f.t += dt;
      const w = f.w0 * Math.max(0, 1 - f.t / f.dur);
      if (w <= 1e-4) {
        a.stop();
        this.fading.delete(a);
        continue;
      }
      a.setEffectiveWeight(w);
      sum += w;
    }
    this.cur?.setEffectiveWeight(Math.max(0, 1 - sum));
  }


  play(name: string, fade = 0.12, t0 = 0): void {
    const f = this.fadeFor(this.logical, name, fade);
    this.logical = name;
    this.held = 0;
    this.landed = false;
    this.guardMoving = false;
    if (name !== "finisher" && name !== "deathblow") this.plungeT = null;
    const vs = this.cfg.plans?.[name] ? null : this.variant(name);
    this.warp = this.warpFor(name, vs?.clip);
    if (this.warp) {
      this.seq = null;
      this.loco = "";
      this.tau = t0;
      this.segI = -1;
      this.applyWarp(f);
      return;
    }
    const plan = this.cfg.plans?.[name];
    if (plan) {
      const tl = this.planLayout(plan);
      let i = 0;
      while (i < plan.length - 1 && t0 >= tl.starts[i + 1]) i++;
      this.seq = { plan, i, starts: tl.starts, ranges: tl.ranges, holdLeft: 0, holdDone: false };
      const sp = this.speedOf({ clip: plan[i].clip, speed: plan[i].speed });
      this.start({ clip: plan[i].clip, speed: plan[i].speed }, f, tl.ranges[i][0] + (t0 - tl.starts[i]) * sp);
      return;
    }
    this.seq = null;
    const s = vs ?? this.spec(name);
    this.loco = s.clip;
    this.start(s, f, t0 * this.speedOf(s));
  }

  get clipName(): string {
    return this.logical;
  }

  private planLayout(plan: Segment[]): { starts: number[]; ranges: [number, number][]; parts: Timeline[]; end: number } {
    const starts: number[] = [];
    const ranges: [number, number][] = [];
    const parts: Timeline[] = [];
    let t = 0;
    for (const s of plan) {
      const c = this.clips.get(s.clip);
      const d = c?.duration ?? 0;
      const sp = s.speed ?? 1;
      const a = (s.from ?? 0) * d;
      const b = (s.to ?? 1) * d;
      starts.push(t);
      ranges.push([a, b]);
      const tl = resolveEvents(this.eventsOf(s.clip), d, sp);
      const peak = tl.windupPeak[0] ?? -1;
      const part = offsetTimeline(tl, t - a / sp, s.hold && peak >= 0 ? peak : Infinity, s.hold ?? 0);
      part.hits = part.hits.filter((h) => h.start < t + (b - a) / sp + (s.hold ?? 0));
      parts.push(part);
      t += (b - a) / sp + (s.hold ?? 0);
    }
    return { starts, ranges, parts, end: t };
  }

  private readonly tlCache = new Map<string, Timeline>();

  timeline(name: string): Timeline {
    if (this.warpFor(name)) {
      let t = this.tlCache.get(name);
      if (!t) this.tlCache.set(name, (t = this.source.timeline(name)));
      return t;
    }
    const plan = this.cfg.plans?.[name];
    if (plan) {
      const l = this.planLayout(plan);
      const tl = mergeTimelines(l.parts);
      tl.end = l.end;
      return tl;
    }
    const s = this.spec(name);
    const c = this.clips.get(s.clip);
    return resolveEvents(this.eventsOf(s.clip), c?.duration ?? 0, this.speedOf(s));
  }

  /** Build (once) the time warp for a logical move; null for loops and moves the procedural body lacks. */
  private warpFor(name: string, clip?: string): Warp | null {
    const key = clip ? `${name}|${clip}` : name;
    if (this.warps.has(key)) return this.warps.get(key)!;
    let w: Warp | null = null;
    const spec = this.cfg.clips[name];
    const has = this.source.listClips().some((c) => c.name === name);
    if (has && !(spec?.loop || spec?.atEnd) && (spec || this.cfg.plans?.[name])) {
      const plan: Segment[] = this.cfg.plans?.[name] ?? [{ clip: clip ?? this.spec(name).clip }];
      const segs: Warp["segs"] = [];
      const cw: number[] = [];
      const ch: [number, number, number][] = [];
      const cs: Record<string, number> = {};
      let off = 0;
      plan.forEach((sg, si) => {
        const c = this.clips.get(sg.clip);
        if (!c) return;
        const d = c.duration;
        const tl = resolveEvents(this.eventsOf(sg.clip), d);
        // Chained segments skip each clip's lead-in / recovery (Mixamo slashes start and end at rest).
        const first = Math.min(...tl.windupPeak, ...tl.hits.map((h) => h.start), d);
        const last = Math.max(...tl.hits.map((h) => h.end), 0);
        const a = si > 0 && plan.length > 1 && first < d ? Math.max(0, first - 0.2) : (sg.from ?? 0) * d;
        const b = si < plan.length - 1 && last > 0 ? Math.min(d, last + 0.2) : (sg.to ?? 1) * d;
        const inR = (x: number) => x >= a - 1e-4 && x <= b + 1e-4;
        const V = (x: number) => off + x - a;
        for (const x of tl.windupPeak) if (inR(x)) cw.push(V(x));
        for (const h of tl.hits) if (inR(h.contact)) ch.push([V(Math.max(a, h.start)), V(h.contact), V(Math.min(b, h.end))]);
        for (const k of ["plunge", "withdraw", "leapOff", "slam"] as const) if (tl[k] >= 0 && inR(tl[k])) cs[k] ??= V(tl[k]);
        for (const [k, x] of Object.entries(tl.cue)) if (inR(x)) cs["cue:" + k] ??= V(x);
        segs.push({ clip: sg.clip, a, b, off });
        off += b - a;
      });
      if (segs.length && off > 0) {
        const g = this.source.timeline(name);
        const pairs: [number, number][] = [[0, 0]];
        g.windupPeak.forEach((x, i) => i < cw.length && pairs.push([x, cw[i]]));
        g.hits.forEach((h, i) => {
          if (i >= ch.length) return;
          pairs.push([h.start, ch[i][0]], [h.contact, ch[i][1]], [h.end, ch[i][2]]);
        });
        for (const k of ["plunge", "withdraw", "leapOff", "slam"] as const) if (g[k] >= 0 && cs[k] !== undefined) pairs.push([g[k], cs[k]]);
        for (const [k, x] of Object.entries(g.cue)) if (cs["cue:" + k] !== undefined) pairs.push([x, cs["cue:" + k]]);
        pairs.sort((p, q) => p[0] - q[0]);
        const end: [number, number] = [Math.max(g.end, 1e-3), off];
        const G: number[] = [];
        const Vv: number[] = [];
        for (const [x, y] of pairs) {
          if (x >= end[0] - 1e-3 || y >= end[1] - 1e-3) continue;
          if (G.length && (x <= G[G.length - 1] + 1e-3 || y <= Vv[Vv.length - 1] + 1e-3)) continue;
          G.push(x);
          Vv.push(y);
        }
        // At most WARP_K× speed-up into the first event and out of the last: a long lead-in or
        // recovery is skipped (the crossfades cover it) rather than played frantically fast.
        const K = spec?.warpK ?? WARP_K;
        if (G.length > 1) Vv[0] = Math.max(0, Vv[1] - G[1] * K);
        const gl = G[G.length - 1];
        const vl = Vv[Vv.length - 1];
        G.push(end[0]);
        Vv.push(Math.max(vl + 1e-3, Math.min(end[1], vl + (end[0] - gl) * K)));
        w = { segs, g: G, v: Vv };
      }
    }
    this.warps.set(key, w);
    return w;
  }

  private readonly autoEv = new Map<string, ClipEvents | undefined>();

  /** A clip's events: the table's, with the blade-motion analysis filling in untuned attacks. */
  private eventsOf(clip: string): ClipEvents | undefined {
    if (this.autoEv.has(clip)) return this.autoEv.get(clip);
    const base = this.cfg.events[clip];
    let ev = base;
    const attack = base && !base.tuned && (base.hits?.length || base.plunge !== undefined);
    const c = this.clips.get(clip);
    if (attack && c) {
      const a = analyzeSwing(this, c);
      if (a) {
        ev = { ...base, norm: false, hits: [{ start: a.start, end: a.end, contact: a.contact }], windupPeak: [a.windup] };
        if (base.plunge !== undefined) Object.assign(ev, { plunge: a.contact, withdraw: Math.min(c.duration * 0.95, a.contact + (a.end - a.start) + 0.35), hits: [] });
        if (base.leapOff !== undefined) Object.assign(ev, { leapOff: a.windup, slam: a.contact });
        if (base.end !== undefined) ev.end = base.norm ? base.end * c.duration : base.end;
        if (base.chain !== undefined) ev.chain = Math.max(a.end, base.norm ? base.chain * c.duration : base.chain);
        if (base.track) ev.track = [[0, Math.max(0.01, a.start - 0.06)]];
        if (base.lunge) ev.lunge = [[Math.max(0, a.start - 0.12), a.contact]];
        if (base.cue) ev.cue = Object.fromEntries(Object.entries(base.cue).map(([k, v]) => [k, base.norm ? v * c.duration : v]));
      }
    }
    this.autoEv.set(clip, ev);
    return ev;
  }

  /** Sample the blade tip in the body frame across a clip (for `analyzeSwing`). */
  sampleTip(clip: THREE.AnimationClip, dt = 1 / 60): { t: number; p: THREE.Vector3 }[] {
    const act = this.mixer.clipAction(clip);
    const cur = this.cur;
    act.play();
    const out: { t: number; p: THREE.Vector3 }[] = [];
    const inv = new THREE.Matrix4();
    for (let t = 0; t <= clip.duration + 1e-6; t += dt) {
      act.time = Math.min(t, clip.duration);
      act.setEffectiveWeight(1);
      this.mixer.update(0);
      this.rig.root.updateMatrixWorld(true);
      inv.copy(this.rig.root.matrixWorld).invert();
      const d = this.cfg.sword;
      out.push({ t: act.time, p: new THREE.Vector3(0, d.tsuba + d.blade, 0).applyMatrix4(this.swordSocket.matrixWorld).applyMatrix4(inv) });
    }
    if (act !== cur) act.stop();
    return out;
  }

  /** Pose the warped move at gameplay time `tau` (switching segment actions with a short fade). */
  private applyWarp(fade = 0.08): void {
    const w = this.warp;
    if (!w) return;
    const t = Math.max(0, this.tau);
    let v = w.v[w.v.length - 1];
    for (let i = 1; i < w.g.length; i++)
      if (t <= w.g[i]) {
        const k = (t - w.g[i - 1]) / Math.max(1e-6, w.g[i] - w.g[i - 1]);
        v = w.v[i - 1] + (w.v[i] - w.v[i - 1]) * k;
        break;
      }
    let i = 0;
    while (i < w.segs.length - 1 && v > w.segs[i].off + (w.segs[i].b - w.segs[i].a)) i++;
    const sg = w.segs[i];
    const ct = Math.min(sg.b, sg.a + v - sg.off);
    if (i !== this.segI) {
      this.start({ clip: sg.clip }, this.segI < 0 ? fade : 0.08, ct);
      this.segI = i;
    }
    if (this.cur) {
      this.cur.setEffectiveTimeScale(0);
      this.cur.time = ct;
    }
  }

  /** Gameplay-clock time of the current move (tests read it like the procedural `anim.time`). */
  get anim(): { time: number } {
    return { time: this.warp ? this.tau : (this.cur?.time ?? 0) };
  }

  // ------------------------------------------------------------------ reactions

  setHold(on: boolean): void {
    if (on && !this.hold && this.bounceT < 0) this.landed = true;
    // Held at a contact found without the IK (snapBack on the reference path): pose the arm now so
    // the very next render already shows the blade on the contact.
    if (on && !this.hold && this.ref) {
      this.applyAssist();
      this.applyGuard();
      this.rig.root.updateMatrixWorld(true);
    }
    this.hold = on;
  }

  snapBack(s: number): void {
    // Rewind the mixer to the contact instant (idempotent), bank the difference as held time.
    const want = -(1 - s) * this.lastDt;
    if (this.warp) {
      this.tau += want - this.rewound;
      this.applyWarp();
    }
    this.mixer.update(want - this.rewound);
    this.held += this.rewound - want;
    this.rewound = want;
    this.applyKicks();
    // Fully on the reference path (a live hit window): the blade *is* the reference blade (FighterSlot
    // re-posed the reference first), so the contact search skips the IK; the next step() poses the arm.
    const onRef = !!this.ref && this.assistW > 0.999 && this.guardW() <= 0;
    if (!onRef) {
      this.applyAssist();
      this.applyGuard();
    }
    this.refresh(0);
    if (onRef) {
      this.rig.hiltW.copy(this.ref!.rig.hiltW);
      this.rig.tipW.copy(this.ref!.rig.tipW);
    }
    this.rig.prevHiltW.copy(this.rig.hiltW);
    this.rig.prevTipW.copy(this.rig.tipW);
  }

  /** Block / deflect: an arm IK layer swings the blade's strong half onto `target` (both arms turn together). */
  guardAt(target: THREE.Vector3 | null): void {
    this.guardTarget = target ? (this.guardTarget ?? new THREE.Vector3()).copy(target) : null;
    this.guardT = target ? 0 : -1;
  }
  private guardT = -1;

  private guardW(): number {
    if (this.guardT < 0) return 0;
    const t = this.guardT;
    return t < GUARD_HOLD ? 1 : Math.max(0, 1 - (t - GUARD_HOLD) / GUARD_OUT);
  }

  private applyGuard(): void {
    const w = this.guardW();
    if (w > 1e-3 && this.guardTarget) {
      const T = this.guardTarget;
      this.armIK(T, w, 0.08, 0.75, true);
      this.armIK(T, w, 0.08, 0.75, true);
      // The last few centimetres: the katana slides in the grip onto the contact.
      const d = this.cfg.sword;
      const S = this.swordSocket;
      this.rig.root.updateMatrixWorld(true);
      const hilt = _g0.set(0, d.tsuba, 0).applyMatrix4(S.matrixWorld);
      const ab = _g1.set(0, d.tsuba + d.blade, 0).applyMatrix4(S.matrixWorld).sub(hilt);
      const u = THREE.MathUtils.clamp(_g2.subVectors(T, hilt).dot(ab) / ab.lengthSq(), 0.05, 0.95);
      const delta = _g2.subVectors(T, _g3.copy(hilt).addScaledVector(ab, u)).multiplyScalar(w);
      if (delta.length() < 0.12) {
        S.position.copy(S.parent!.worldToLocal(S.getWorldPosition(_g3).add(delta)));
        S.updateMatrixWorld(true);
      }
    }
    const bw = this.bounceW();
    if (bw > 1e-3 && this.bounceAt && !this.ref) this.armIK(this.bounceAt, bw, 0.3, 0.7);
    // Blade avoidance (resting inside the other fighter outside a strike): lift it up and back.
    const aw = this.avoidW * (1 - Math.max(this.guardW(), this.pastContact ? 0 : this.assistW));
    if (aw > 1e-3 && this.ref) {
      const d = this.cfg.sword;
      this.rig.root.updateMatrixWorld(true);
      const mid = _g0.set(0, d.tsuba + d.blade * 0.5, 0).applyMatrix4(this.swordSocket.matrixWorld);
      const back = _g1.copy(this.rig.chestW).sub(mid).setY(0);
      if (back.lengthSq() > 1e-6) back.setLength(0.35);
      this.armIK(_avoidT.copy(mid).add(back).add(_v.set(0, 0.45, 0)), aw, 0.4, 0.6);
    }
  }

  /**
   * Inside a live hit window (ramped in 0.1 s before, out 0.12 s after) the blade is steered onto
   * the procedural rig's blade — hilt by arm IK, direction by the wrist — so what connects, when and
   * where, is exactly the tuned combat; outside the windows the clip plays untouched.
   */
  private assistW = 0;
  private plungeT: THREE.Vector3 | null = null;
  /** Deathblows: drive the blade's forward half into `target` (the opponent's chest, live) in the plunge. */
  plungeInto(target: THREE.Vector3 | null): void {
    this.plungeT = target;
  }
  /** The blade is on the procedural rig's path (FighterSlot forwards blade avoidance to it then). */
  get assisting(): boolean {
    return this.assistW > 0.99;
  }
  /** Past the current strike's contact, inside its window (the blow has landed or been guarded). */
  private get pastContact(): boolean {
    const t = this.tau;
    return this.landed || (!!this.warp && this.bounceT < 0 && this.timeline(this.logical).hits.some((h) => t >= h.contact && t <= h.end + 0.12));
  }
  /** The blow connected (held at the contact) and wasn't guarded: from here the blade may lift clear. */
  private landed = false;
  private readonly sockPos = new THREE.Vector3();
  private readonly sockQ = new THREE.Quaternion();

  private applyAssist(dt = 0): void {
    const ref = this.ref;
    if (!ref) return;
    this.swordSocket.position.copy(this.sockPos);
    this.swordSocket.quaternion.copy(this.sockQ);
    let want = 0;
    if (this.warp) {
      const t = this.tau;
      const tl = this.timeline(this.logical);
      for (const h of tl.hits) {
        const k = t < h.start ? 1 - (h.start - t) / 0.1 : t > h.end ? 1 - (t - h.end) / 0.12 : 1;
        want = Math.max(want, Math.min(1, Math.max(0, k)));
      }
      // Deathblows: the blade goes into him (his chest, or the tuned plunge path), plunge to withdraw.
      if (tl.plunge >= 0) {
        const a = tl.plunge - 0.15;
        const b = tl.withdraw >= 0 ? tl.withdraw : tl.plunge + 0.6;
        const k = t < a ? 1 - (a - t) / 0.15 : t > b ? 1 - (t - b) / 0.25 : 1;
        const kw = Math.min(1, Math.max(0, k));
        if (this.plungeT) {
          if (kw > 1e-3) this.armIK(this.plungeT, kw * kw * (3 - 2 * kw), 0.55, 0.85, true);
        } else want = Math.max(want, kw);
      }
    }
    // A guarded blow rebounds exactly as the procedural rig's does (anchored at the contact), and
    // a deflected fighter's recoil keeps the tuned blade path (it starts point blank).
    want = Math.max(want, this.bounceT >= 0 && this.bounceT < this.bounceHoldEnd + 0.3 ? 1 : 0, this.logical === "recoil" ? 1 : 0);
    // Rate-limited, so a state change (deflected → recoil) never snaps the blade back to the clip.
    this.assistW = want > this.assistW ? want : Math.max(want, this.assistW - dt * 7);
    let w = this.assistW;
    if (w <= 1e-3) return;
    w = w * w * (3 - 2 * w);
    const hand = this.bones.get(this.cfg.sword.bone);
    const d = this.cfg.sword;
    const rh = ref.rig;
    for (let it = 0; it < 3; it++) {
      this.armIK(rh.hiltW, w, 0, 0, true);
      if (!hand) break;
      this.rig.root.updateMatrixWorld(true);
      const hilt = _g0.set(0, d.tsuba, 0).applyMatrix4(this.swordSocket.matrixWorld);
      const tip = _g1.set(0, d.tsuba + d.blade, 0).applyMatrix4(this.swordSocket.matrixWorld);
      _gq.setFromUnitVectors(_g2.subVectors(tip, hilt).normalize(), _g3.subVectors(rh.tipW, rh.hiltW).normalize());
      _gq.slerp(_gi, 1 - w);
      const pw = hand.parent!.getWorldQuaternion(_gpq);
      const bw = hand.getWorldQuaternion(_gbq);
      hand.quaternion.copy(pw.invert().multiply(_gq).multiply(bw));
      hand.updateMatrixWorld(true);
    }
    this.armIK(rh.hiltW, w, 0, 0, true);
    // What the arm can't reach, the grip takes up: the katana slides / turns a little in the hand.
    this.rig.root.updateMatrixWorld(true);
    const S = this.swordSocket;
    const hilt = _g0.set(0, d.tsuba, 0).applyMatrix4(S.matrixWorld);
    const tip = _g1.set(0, d.tsuba + d.blade, 0).applyMatrix4(S.matrixWorld);
    const q = _gq.setFromUnitVectors(_g2.subVectors(tip, hilt).normalize(), _g3.subVectors(rh.tipW, rh.hiltW).normalize()).slerp(_gi, 1 - w);
    const sw = S.getWorldQuaternion(_gpq);
    const pq = S.parent!.getWorldQuaternion(_gbq);
    S.quaternion.copy(pq.clone().invert().multiply(q).multiply(sw));
    S.updateMatrixWorld(true);
    const h2 = _g1.set(0, d.tsuba, 0).applyMatrix4(S.matrixWorld);
    const delta = _g2.subVectors(rh.hiltW, h2).multiplyScalar(w);
    if (delta.length() < 0.25) {
      const wp = S.getWorldPosition(_g3).add(delta);
      S.position.copy(S.parent!.worldToLocal(wp));
      S.updateMatrixWorld(true);
    }
  }

  /**
   * CCD over the sword arm (forearm, then upper arm; the left arm follows the upper arm's turn so
   * both hands stay on the hilt) until the blade's `u0..u1` part passes through `T` (weight `w`).
   */
  private ikChains: { arms: THREE.Bone[]; full: THREE.Bone[]; arm?: THREE.Bone; left?: THREE.Bone; trunk: Set<THREE.Bone> } | null = null;

  private armIK(T: THREE.Vector3, w: number, u0: number, u1: number, spine = false): void {
    if (!this.ikChains) {
      const g = (n: string) => this.bones.get(n);
      const arm = g("RightArm");
      const fore = g("RightForeArm");
      const trunk = ["Spine2", "Spine1"].map(g).filter((x): x is THREE.Bone => !!x);
      const arms = arm ? (fore ? [fore, arm] : [arm]) : [];
      this.ikChains = { arms, full: [...arms, ...trunk], arm, left: g("LeftArm"), trunk: new Set(trunk) };
    }
    const K = this.ikChains;
    if (!K.arm) return;
    const chain = spine ? K.full : K.arms;
    const d = this.cfg.sword;
    this.rig.root.updateMatrixWorld(true);
    for (let it = 0; it < 6; it++)
      for (const b of chain) {
        // (turn() keeps every rotated bone's subtree up to date, so no full-rig update in the loop.)
        this.swordSocket.updateWorldMatrix(true, false);
        const hilt = _g0.set(0, d.tsuba, 0).applyMatrix4(this.swordSocket.matrixWorld);
        const tip = _g1.set(0, d.tsuba + d.blade, 0).applyMatrix4(this.swordSocket.matrixWorld);
        const ab = _g2.subVectors(tip, hilt);
        const u = THREE.MathUtils.clamp(_g3.subVectors(T, hilt).dot(ab) / ab.lengthSq(), u0, u1);
        const P = _g3.copy(hilt).addScaledVector(ab, u);
        const S = b.getWorldPosition(_g4);
        _gq.setFromUnitVectors(_g5.subVectors(P, S).normalize(), _g6.subVectors(T, S).normalize());
        // The trunk only leans a share of the way (and less per bone) so the arms do most of it.
        _gq.slerp(_gi, 1 - w * (K.trunk.has(b) ? 0.5 : 1));
        turnBone(b, _gq);
        if (b === K.arm && K.left) turnBone(K.left, _gq);
      }
  }




  /**
   * Stopped by a guard: the blade's middle stays anchored at the contact, lifted up and back
   * toward the attacker (arm IK), instead of the clip carrying it on through the defender.
   */
  bounce(hold = 0): void {
    this.landed = false;
    this.bounceT = 0;
    this.bounceHoldEnd = 0.1 + hold;
    const d = this.cfg.sword;
    this.rig.root.updateMatrixWorld(true);
    const mid = new THREE.Vector3(0, d.tsuba + d.blade * 0.5, 0).applyMatrix4(this.swordSocket.matrixWorld);
    const back = this.rig.chestW.clone().sub(mid).setY(0);
    if (back.lengthSq() > 1e-6) back.normalize().multiplyScalar(0.16);
    this.bounceAt = mid.add(back).add(_v.set(0, 0.22, 0));
  }
  private bounceHoldEnd = 0.1;
  private bounceAt: THREE.Vector3 | null = null;

  private bounceW(): number {
    if (this.bounceT < 0) return 0;
    const t = this.bounceT;
    const w = t < 0.06 ? t / 0.06 : t < this.bounceHoldEnd ? 1 : Math.max(0, 1 - (t - this.bounceHoldEnd) / 0.3);
    return w * w * (3 - 2 * w);
  }

  setAvoid(on: boolean): void {
    this.avoid = on;
  }

  /** Bone kicks: blade avoidance, plus a little spine rock-back under the rebound IK. */
  private kickW(): number {
    return this.ref ? 0 : Math.max(this.bounceW() * 0.35, this.avoidW);
  }

  private applyKicks(): void {
    const w = this.kickW();
    if (w <= 1e-3) return;
    for (const k of this.cfg.kicks) {
      const b = this.bones.get(k.bone);
      if (!b) continue;
      _q.setFromAxisAngle(_ax.set(k.axis[0], k.axis[1], k.axis[2]).normalize(), k.angle * w);
      b.quaternion.multiply(_q);
    }
  }

  // ------------------------------------------------------------------ stepping

  /** Idle / walk pick a locomotion clip from the local velocity. */
  private locomotion(): void {
    const L = this.cfg.locomotion;
    const cy = Math.cos(this.rig.yaw);
    const sy = Math.sin(this.rig.yaw);
    const fwd = this.rig.vel.x * sy + this.rig.vel.z * cy;
    const side = this.rig.vel.x * cy - this.rig.vel.z * sy;
    const sp = Math.hypot(fwd, side);
    this.legsWant = "";
    if (this.logical === "guard" && !this.seq && !this.warp) {
      const g = this.cfg.clips.guard?.clip ?? "";
      const moving = sp > 0.5 && this.clips.has(`${g}__upper`);
      if (moving !== this.guardMoving) {
        this.guardMoving = moving;
        this.start({ clip: moving ? `${g}__upper` : g, loop: true }, LEG_FADE, this.cur?.time ?? 0);
      }
      if (moving) {
        const c = Math.abs(side) > Math.abs(fwd) ? (side > 0 ? L.left : L.right) : fwd < 0 ? L.back : L.walk;
        this.legsWant = c && this.clips.has(`${c}__lower`) ? `${c}__lower` : `${L.walk}__lower`;
        this.legsSpeed = Math.max(0.5, Math.min(1.6, sp / L.walkSpeed));
      }
      return;
    }
    if (this.seq || (this.logical !== L.idle && this.logical !== "idle" && this.logical !== "walk")) return;
    let clip = L.idle;
    // Turning on the spot (lock-on tracking, the guard swinging round): step-turn clips if present.
    const yr = this.yawRate;
    if (sp <= 0.4 && Math.abs(yr) > 1.6 && L.turnLeft && L.turnRight) {
      const t = yr > 0 ? L.turnLeft : L.turnRight;
      if (this.clips.has(t)) clip = t;
    }
    if (sp > 0.4) {
      if (L.run && sp > (L.walkSpeed + L.runSpeed) / 2) clip = L.run;
      else if (Math.abs(side) > Math.abs(fwd)) clip = (side > 0 ? L.left : L.right) ?? L.walk;
      else clip = fwd < 0 ? (L.back ?? L.walk) : L.walk;
    }
    if (!this.clips.has(clip)) clip = this.clips.has(L.walk) && sp > 0.4 ? L.walk : L.idle;
    if (clip !== this.loco) {
      this.loco = clip;
      this.start({ clip, loop: true }, 0.25, this.cur?.time ?? 0);
    }
    if (this.cur && clip !== L.idle) this.cur.setEffectiveTimeScale(Math.max(0.5, Math.min(1.6, sp / (clip === L.run ? L.runSpeed : L.walkSpeed))));
  }

  private guardMoving = false;
  private legsWant = "";
  private legsSpeed = 1;
  private readonly legs = new Map<string, { a: THREE.AnimationAction; w: number }>();

  /** Leg layer under the moving guard: faded at the same rate as the guard pose it complements. */
  private updateLegs(dt: number): void {
    if (this.legsWant && !this.legs.has(this.legsWant)) {
      const a = this.mixer.clipAction(this.clips.get(this.legsWant)!);
      a.reset().setLoop(THREE.LoopRepeat, Infinity).setEffectiveWeight(0).play();
      this.legs.set(this.legsWant, { a, w: 0 });
    }
    for (const [n, l] of this.legs) {
      const want = n === this.legsWant ? 1 : 0;
      l.w = want > l.w ? Math.min(want, l.w + dt / LEG_FADE) : Math.max(want, l.w - dt / LEG_FADE);
      if (l.w <= 0 && want === 0) {
        l.a.stop();
        this.legs.delete(n);
        continue;
      }
      l.a.setEffectiveWeight(l.w);
      l.a.setEffectiveTimeScale(this.legsSpeed);
    }
  }

  private sequence(): void {
    const q = this.seq;
    if (!q || !this.cur) return;
    const seg = q.plan[q.i];
    const b = q.ranges[q.i][1];
    // Delayed blow: pause at the wind-up peak (clip seconds).
    const peak = resolveEvents(this.eventsOf(seg.clip), this.clips.get(seg.clip)?.duration ?? 0).windupPeak[0];
    if (seg.hold && !q.holdDone && peak !== undefined && this.cur.time >= peak) {
      q.holdDone = true;
      q.holdLeft = seg.hold;
      this.cur.setEffectiveTimeScale(0);
    }
    if (q.holdLeft > 0) return;
    if (this.cur.time >= b - 1e-4 && q.i < q.plan.length - 1) {
      q.i++;
      q.holdDone = false;
      const n = q.plan[q.i];
      this.start({ clip: n.clip, speed: n.speed }, 0.08, q.ranges[q.i][0]);
    }
  }

  private refresh(dt: number): void {
    const r = this.rig;
    r.prevHiltW.copy(r.hiltW);
    r.prevTipW.copy(r.tipW);
    this.swordSocket.updateWorldMatrix(true, false);
    const d = this.cfg.sword;
    r.hiltW.set(0, d.tsuba, 0).applyMatrix4(this.swordSocket.matrixWorld);
    r.tipW.set(0, d.tsuba + d.blade, 0).applyMatrix4(this.swordSocket.matrixWorld);
    if (r.first) {
      r.prevHiltW.copy(r.hiltW);
      r.prevTipW.copy(r.tipW);
      r.first = false;
    }
    const B = this.cfg.bones;
    const w = (n: string, out: THREE.Vector3) => (this.bones.get(n) ? this.bones.get(n)!.getWorldPosition(out) : out.copy(r.root.position));
    w(B.hips, r.hipsW);
    w(B.chest, r.chestW);
    w(B.head, r.headW);
    w(B.rightLeg, r.kneeW[0]);
    w(B.leftLeg, r.kneeW[1]);
    // Footfalls from the locomotion clip's events.
    const ev = this.loco ? this.cfg.events[this.loco]?.footsteps : undefined;
    if (ev && this.cur && dt > 0) {
      const c = this.cur.getClip();
      const u = c.duration > 0 ? (this.cur.time % c.duration) / c.duration : 0;
      for (const f of ev) if ((this.footPrev < f && u >= f) || (this.footPrev > u && (f >= this.footPrev || f <= u))) r.onStep?.(0, r.vel.length());
      this.footPrev = u;
    }
  }

  private yawRate = 0;
  private lastYaw = 0;

  step(dt: number, wind: THREE.Vector3, t: number): void {
    const r = this.rig;
    // Shrunk away rather than hidden, so its geometry is on the GPU from the first frame (no upload mid-fight).
    if (this.gourd) this.gourd.children[0].scale.setScalar(this.cfg.gourd?.during.includes(this.logical) ? 1 : 1e-4);
    if (dt > 0) {
      let dy = r.yaw - this.lastYaw;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      this.yawRate += (dy / dt - this.yawRate) * Math.min(1, dt * 8);
    }
    this.lastYaw = r.yaw;
    r.root.rotation.y = r.yaw;
    this.lastDt = dt;
    this.rewound = 0;
    this.locomotion();
    this.sequence();
    if (this.seq && this.seq.holdLeft > 0) {
      this.seq.holdLeft -= dt;
      if (this.seq.holdLeft <= 0 && this.cur) this.cur.setEffectiveTimeScale(this.speedOf({ clip: this.seq.plan[this.seq.i].clip, speed: this.seq.plan[this.seq.i].speed }));
    }
    const frozen = this.hold || (this.bounceT >= 0 && this.bounceT < 0.1);
    if (this.bounceT >= 0 && !this.hold) {
      this.bounceT += dt;
      if (this.bounceT > this.bounceHoldEnd + 0.3) this.bounceT = -1;
    }
    this.avoidW += ((this.avoid ? 1 : 0) - this.avoidW) * (1 - Math.exp(-dt * (this.avoid ? 25 : 12)));
    if (frozen) {
      this.held += dt;
      this.updateFades(0);
      this.updateLegs(0);
      this.mixer.update(0);
    } else {
      // Banked hold time is caught up on the clip clock only; fades run on real steps.
      const extra = Math.min(this.held, dt);
      this.held -= extra;
      if (this.warp) {
        this.tau += dt + extra;
        this.applyWarp();
      }
      this.updateFades(dt);
      this.updateLegs(dt);
      this.mixer.update(this.warp ? dt : dt + extra);
    }
    this.applyKicks();
    if (this.guardT >= 0 && !frozen) {
      this.guardT += dt;
      if (this.guardW() <= 0) this.guardT = -1;
    }
    this.applyAssist(dt);
    this.applyGuard();
    r.root.updateMatrixWorld(true);
    this.refresh(dt);
    const c = this.colliders;
    c[0].c.copy(r.chestW);
    c[1].c.copy(r.hipsW);
    c[2].c.copy(r.kneeW[0]);
    c[3].c.copy(r.kneeW[1]);
    c[4].c.copy(r.headW);
    c[0].r = c[1].r = r.capsule(_v, _v) * 0.65;
    if (dt <= 0) return;
    for (const cl of this.cloths) {
      for (let i = 0; i < cl.pins.length; i++) cl.cloth.pin(i, cl.pins[i].getWorldPosition(_v));
      cl.cloth.step(dt, wind, t, this.colliders);
    }
  }

  frame(dt: number): void {
    for (const c of this.cloths) c.cloth.updateMesh();
    this.trail.update(dt, this.rig.hiltW, this.rig.tipW);
  }

  beginRender(d: THREE.Vector3): void {
    this.simPos.copy(this.rig.root.position);
    this.rig.root.position.add(d);
    for (const c of this.cloths) c.cloth.mesh.position.copy(d);
    this.trail.mesh.position.copy(d);
  }

  endRender(): void {
    this.rig.root.position.copy(this.simPos);
    this.rig.root.updateMatrixWorld(true);
  }

  resetCloth(): void {
    for (const c of this.cloths) c.cloth.reset();
    this.trail.clear();
    this.rig.resetTrail();
    this.hold = false;
    this.held = 0;
    this.bounceT = -1;
    this.avoid = false;
    this.avoidW = 0;
    this.guardAt(null);
  }

  addTo(scene: THREE.Scene): void {
    scene.add(this.rig.root);
    for (const c of this.cloths) scene.add(c.cloth.mesh);
    scene.add(this.trail.mesh);
  }

  setVisible(on: boolean): void {
    this.rig.root.visible = on;
    for (const c of this.cloths) c.cloth.mesh.visible = on;
    this.trail.mesh.visible = on && this.trail.mesh.visible;
  }

  /** Debug: move the katana socket live (metres / radians in the hand bone's frame). */
  tuneSword(offset: [number, number, number], rot: [number, number, number]): void {
    const ws = (this.swordSocket.parent ?? this.model).getWorldScale(_v).x || 1;
    this.swordSocket.position.set(offset[0] / ws, offset[1] / ws, offset[2] / ws);
    this.swordSocket.rotation.set(rot[0], rot[1], rot[2]);
    this.sockPos.copy(this.swordSocket.position);
    this.sockQ.copy(this.swordSocket.quaternion);
  }

  /** Debug scrub: pose `clip` at clip time `t` (seconds), gameplay untouched. */
  scrub(clip: string, t: number): void {
    this.seq = null;
    this.warp = null;
    this.logical = clip;
    this.loco = clip;
    this.start({ clip, loop: false }, 0, t);
    this.cur!.setEffectiveTimeScale(0);
    this.mixer.update(0);
    this.rig.root.updateMatrixWorld(true);
    this.refresh(0);
  }
}

/**
 * The cut in an attack clip, from the blade tip's motion in the body frame: the window where the
 * tip moves fast (> 30% of its peak) while out in front (> 50% of its furthest reach), the one
 * holding the furthest-forward instant (contact); wind-up = the slowest moment in the 0.6 s before.
 */
function analyzeSwing(body: SkinnedCharacter, clip: THREE.AnimationClip): { start: number; end: number; contact: number; windup: number } | null {
  const s = body.sampleTip(clip);
  if (s.length < 4) return null;
  const sp = s.map((x, i) => (i ? x.p.distanceTo(s[i - 1].p) / Math.max(1e-4, x.t - s[i - 1].t) : 0));
  sp[0] = sp[1];
  const fwd = s.map((x) => x.p.z);
  const peak = Math.max(...sp);
  const reach = Math.max(...fwd);
  if (!(peak > 0.5) || !(reach > 0.2)) return null;
  // Contact: furthest forward among fast frames (fall back to furthest forward).
  let best = -1;
  for (let i = 0; i < s.length; i++) if (sp[i] > peak * 0.3 && (best < 0 || fwd[i] > fwd[best])) best = i;
  if (best < 0) best = fwd.indexOf(reach);
  const on = (i: number) => sp[i] > peak * 0.3 && fwd[i] > reach * 0.5;
  let i0 = best;
  while (i0 > 0 && on(i0 - 1)) i0--;
  let i1 = best;
  while (i1 < s.length - 1 && on(i1 + 1)) i1++;
  // At least ~0.1 s of active window, centred on the contact.
  const dt = s[1].t - s[0].t;
  while ((i1 - i0) * dt < 0.1 && (i0 > 0 || i1 < s.length - 1)) {
    if (i0 > 0) i0--;
    if ((i1 - i0) * dt < 0.1 && i1 < s.length - 1) i1++;
  }
  // A cut that is already under way on the first frame isn't a usable anchor: keep the table's.
  if (s[best].t < 0.08 || i0 === 0) return null;
  let w = i0;
  for (let k = i0; k >= 0 && s[i0].t - s[k].t < 0.6; k--) if (sp[k] < sp[w]) w = k;
  if (w === i0) w = Math.max(0, i0 - 1);
  return { start: s[i0].t, end: s[i1].t, contact: s[best].t, windup: s[w].t };
}

/** A tinted copy of a (shared) material. */
function tinted(m: THREE.MeshStandardMaterial, color: number): THREE.MeshStandardMaterial {
  const c = m.clone();
  c.color.set(color);
  return c;
}

/**
 * Fresnel rim added to the emissive term (all lights: it lifts the silhouette off the sky). The
 * colour is the character's live `rimColor` (base rim + any glow: curse, heal, rage); `glowBody`
 * spreads that glow over the whole body, not just the edges.
 */
function addRim(m: THREE.MeshStandardMaterial, rimColor: THREE.Color, glowBody: { value: number }): void {
  if (!m || !(m as THREE.MeshStandardMaterial).isMeshStandardMaterial) return;
  m.onBeforeCompile = (sh) => {
    sh.uniforms.rimColor = { value: rimColor };
    sh.uniforms.uGlowBody = glowBody;
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform vec3 rimColor;\nuniform float uGlowBody;")
      .replace(
        "#include <emissivemap_fragment>",
        "#include <emissivemap_fragment>\n  { float rf = 1.0 - saturate(dot(normal, normalize(vViewPosition))); totalEmissiveRadiance += rimColor * (pow(rf, 3.0) + uGlowBody * (0.25 + 0.75 * rf * rf)); }",
      );
  };
  m.customProgramCacheKey = () => "rim";
  m.needsUpdate = true;
}

/** A small lacquered hyōtan gourd (lathe, cord at the waist), stopper up (+Y). */
function makeGourd(): THREE.Object3D {
  const pts: THREE.Vector2[] = [];
  const prof = (y: number) => (y < 0.07 ? 0.042 * Math.sin((y / 0.07) * Math.PI * 0.95 + 0.1) : y < 0.1 ? 0.018 : 0.028 * Math.sin(((y - 0.1) / 0.06) * Math.PI * 0.95 + 0.1));
  for (let i = 0; i <= 24; i++) {
    const y = (i / 24) * 0.16;
    pts.push(new THREE.Vector2(Math.max(0.004, prof(y)), y - 0.06));
  }
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.LatheGeometry(pts, 14), new THREE.MeshStandardMaterial({ color: 0x8a4a1c, roughness: 0.45 }));
  const cord = new THREE.Mesh(new THREE.TorusGeometry(0.02, 0.004, 5, 12), new THREE.MeshStandardMaterial({ color: 0x9b1e1a, roughness: 0.9 }));
  cord.rotation.x = Math.PI / 2;
  cord.position.y = 0.025;
  const plug = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.01, 0.018, 8), new THREE.MeshStandardMaterial({ color: 0x2a1a10, roughness: 0.8 }));
  plug.position.y = 0.105;
  g.add(body, cord, plug);
  g.traverse((o) => (o.castShadow = true));
  return g;
}

/** Apply a world-space rotation delta to a bone (local' = parentW⁻¹ · Δ · boneW), subtree updated. */
function turnBone(b: THREE.Bone, q: THREE.Quaternion): void {
  const pw = b.parent!.getWorldQuaternion(_gpq);
  const bw = b.getWorldQuaternion(_gbq);
  b.quaternion.copy(pw.invert().multiply(q).multiply(bw));
  b.updateMatrixWorld(true);
}
