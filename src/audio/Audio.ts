/**
 * GameAudio: the game's sound API (method names are the call sites' contract). Every sound is
 * synthesised at runtime with Web Audio — no samples. Modules:
 *   mix.ts       buses (sfx / voice / music / ambience → master → glue comp → limiter → safety clip),
 *                rooftop reverb, positional emitters, sidechain-style ducking, primitives
 *   synth.ts     generated buffers: noise, pink noise, rooftop IR, Karplus-Strong shamisen / koto
 *   voice.ts     formant voices (kunoichi breaths / hurt, general kiai / battle cry)
 *   music.ts     adaptive taiko ensemble + shakuhachi / koto line, stings
 *   ambience.ts  wind howl + gusts + whistle, snow hush, temple bell, lantern creak
 * The context starts on the first key or click (autoplay rules). "M" mutes (remembered).
 */
import { clamp } from "../core/math";
import { Ambience } from "./ambience";
import { Mix, type Emitter } from "./mix";
import { Music } from "./music";
import { makeString, SHAMISEN } from "./synth";
import { Voices } from "./voice";

interface V3 {
  x: number;
  y: number;
  z: number;
}
interface CamLike {
  position: V3;
  matrixWorld: { elements: ArrayLike<number> };
}

const MUTE_KEY = "shinobi-duel.muted";
const rand = (a: number, b: number) => a + Math.random() * (b - a);

export class GameAudio {
  private ctx: BaseAudioContext | null = null;
  private mix!: Mix;
  private music!: Music;
  private amb!: Ambience;
  private voice!: Voices;
  private shamisen!: AudioBuffer;
  private ring!: GainNode;
  private chainN = 0;
  private lastDeflect = -9;
  private charge: { nodes: AudioNode[]; srcs: AudioScheduledSourceNode[]; out: GainNode } | null = null;
  private charging = false;
  private sceneName = "";
  private swingN = 0;
  intensity = 0;
  taikoTempo = 72;

  constructor() {
    if (typeof window === "undefined") return;
    const kick = () => {
      window.removeEventListener("pointerdown", kick);
      window.removeEventListener("keydown", kick);
      this.start();
    };
    window.addEventListener("pointerdown", kick);
    window.addEventListener("keydown", kick);
    window.addEventListener("keydown", (e) => {
      if (e.code !== "KeyM" || e.repeat) return;
      const m = !(this.ctx ? this.mix.muted : localStorage.getItem(MUTE_KEY) === "1");
      try {
        localStorage.setItem(MUTE_KEY, m ? "1" : "0");
      } catch {
        /* storage blocked */
      }
      if (this.ctx) this.mix.setMuted(m);
    });
  }

  start(): void {
    if (typeof location !== "undefined" && location.search.includes("audio=off")) return;
    if (this.ctx) {
      if (this.ctx instanceof AudioContext && this.ctx.state === "suspended") void this.ctx.resume();
      return;
    }
    this.attach(new AudioContext({ latencyHint: "interactive" }));
    let muted = false;
    try {
      muted = localStorage.getItem(MUTE_KEY) === "1";
    } catch {
      /* storage blocked */
    }
    if (muted) this.mix.setMuted(true);
  }

  /** Build the graph on any context (tools/audio-render.mjs passes an OfflineAudioContext). */
  attach(ctx: BaseAudioContext, o: { ambience?: boolean } = {}): void {
    this.ctx = ctx;
    this.mix = new Mix(ctx);
    this.voice = new Voices(this.mix);
    this.music = new Music(this.mix);
    this.amb = new Ambience(this.mix);
    this.amb.on = o.ambience ?? true;
    this.shamisen = makeString(ctx, 146.83, SHAMISEN);
    this.ring = ctx.createGain();
    this.ring.connect(this.mix.em.c.in);
  }

  get running(): boolean {
    return !!this.ctx && (!(this.ctx instanceof AudioContext) || this.ctx.state === "running");
  }

  get muted(): boolean {
    return !!this.ctx && this.mix.muted;
  }

  /** Scene-wide duck of music + ambience (cinematics). */
  setDuck(v: number): void {
    if (this.ctx) this.mix.setSceneDuck(v);
  }

  /** [audio hook] Per frame from Game: scene state, listener + emitters, music inputs. Allocation-free. */
  scene(state: string, cam: CamLike | null, p: V3 | null, b: V3 | null, phase: number, charging: boolean): void {
    if (!this.ctx) return;
    if (state !== this.sceneName) {
      const prev = this.sceneName;
      this.sceneName = state;
      this.music.setScene(state);
      if (state === "victory" && prev !== "victory") this.mix.setSceneDuck(1);
    }
    this.music.phase = phase;
    if (charging !== this.charging) {
      this.charging = charging;
      if (charging) this.chargeStart();
      else this.chargeStop();
    }
    if (!cam || !p || !b) return;
    const e = cam.matrixWorld.elements;
    const rx = e[0], ry = e[1], rz = e[2];
    const c = cam.position;
    const em = this.mix.em;
    this.placeAt(em.p, c, rx, ry, rz, p.x, p.y + 1.1, p.z);
    this.placeAt(em.pv, c, rx, ry, rz, p.x, p.y + 1.5, p.z);
    this.placeAt(em.b, c, rx, ry, rz, b.x, b.y + 1.2, b.z);
    this.placeAt(em.bv, c, rx, ry, rz, b.x, b.y + 1.8, b.z);
    this.placeAt(em.c, c, rx, ry, rz, (p.x + b.x) / 2, (p.y + b.y) / 2 + 1.3, (p.z + b.z) / 2);
  }

  private placeAt(em: Emitter, c: V3, rx: number, ry: number, rz: number, x: number, y: number, z: number): void {
    const dx = x - c.x, dy = y - c.y, dz = z - c.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    const pan = clamp(((dx * rx + dy * ry + dz * rz) / d) * 0.6, -0.6, 0.6);
    const gain = clamp(1 / (1 + 0.09 * Math.max(0, d - 4)), 0.45, 1);
    this.mix.place(em, pan, gain);
  }

  update(dt: number): void {
    if (!this.ctx) return;
    this.amb.intensity = this.intensity;
    this.amb.update(dt);
    this.music.intensity = clamp((this.intensity - 0.4) / 0.6, 0, 1);
    this.music.tempo = this.taikoTempo;
    this.music.update();
  }

  // ------------------------------------------------------------------ combat

  /**
   * Blade on blade. `power` ≥ 0.85 = the player's perfect deflect (the hero sound): transient crack,
   * a bank of inharmonic detuned steel modes with a long shimmering ring-out, body thump, a
   * pre-delayed reverb tail; pitch varies per hit and climbs through a deflect chain.
   * Lower powers are other blade contacts (his guard, glancing cuts): shorter, no chain.
   */
  clang(power = 1): void {
    if (!this.ctx) return;
    const m = this.mix;
    const t = m.now;
    const d = m.em.c.in;
    const hero = power >= 0.85;
    if (hero) {
      this.chainN = t - this.lastDeflect < 1.3 ? Math.min(this.chainN + 1, 6) : 0;
      this.lastDeflect = t;
    }
    // Chains: a slight climb (+1.2% a step, capped) with an alternating low/high answer, like a rhythm.
    const pitch = hero ? (1 + Math.min(this.chainN, 4) * 0.012) * (this.chainN % 2 ? 0.965 : 1) * rand(0.985, 1.015) : 0.94 * rand(0.97, 1.03);
    const P = power;
    // Crack: a hard, very short broadband click plus a bright sizzle.
    m.noiseHit(d, t, 0.018, "highpass", 1800, 0.7, 0.22 * P, { attack: 0.0005 });
    m.noiseHit(d, t, 0.006, "lowpass", 9000, 0.5, 0.1 * P, { attack: 0.0003 });
    m.noiseHit(d, t + 0.002, 0.16, "bandpass", 4200 * pitch, 1.1, 0.14 * P, { to: 2600, verb: 0.3 });
    // The "clang" mass: a mid band of noise under the modes.
    m.noiseHit(d, t, 0.06, "bandpass", 2000 * pitch, 2, 0.3 * P);
    // Body thump (the arms taking the blow).
    m.osc(d, t, 190, 70, 0.16, 0.6 * P);
    m.osc(d, t, 420 * pitch, 380 * pitch, 0.22, 0.12 * P); // low-mid body
    m.noiseHit(d, t, 0.05, "bandpass", 700, 1, 0.3 * P);
    // Steel modes: free-free bar ratios + plate-ish extras, each a detuned pair (beating shimmer).
    const base = 650 * pitch;
    const ring = hero ? 1 + power * 0.35 : 0.5 + power * 0.5;
    // Choke the previous ring (−6 dB over 25 ms) so a chain stays a rhythm, not a wash.
    const ringBus = this.ring;
    const rg = ringBus.gain;
    rg.cancelScheduledValues(t);
    rg.setValueAtTime(rg.value, t);
    rg.linearRampToValueAtTime(0.5, t + 0.025);
    rg.linearRampToValueAtTime(1, t + 0.03);
    const modes: [number, number, number][] = [
      [1, 0.13, 1.25],
      [1.506, 0.07, 0.9],
      [2.756, 0.06, 1.1],
      [3.98, 0.028, 0.7],
      [5.404, 0.013, 0.6],
      [7.08, 0.006, 0.4],
      [8.933, 0.0045, 0.3],
    ];
    for (const [r, g, dec] of modes) {
      const f = base * r * rand(0.994, 1.006);
      const dur = dec * ring;
      const gg = g * P * 1.7;
      m.osc(ringBus, t, f, f, dur, gg, { attack: 0.0008, verb: hero ? 0.35 : 0.2 });
      m.osc(ringBus, t, f * rand(1.003, 1.007), f, dur * 0.8, gg * 0.7, { attack: 0.0008, verb: hero ? 0.25 : 0.15 });
    }
    if (hero) {
      // A high glassy overtone that blooms slightly late — the "shing" that lingers.
      m.osc(ringBus, t + 0.01, base * 3.3, base * 3.3, 1.0, 0.014, { attack: 0.03, verb: 0.5 });
      m.duck(this.chainN > 0 ? 0.55 : 0.4, 0.12, 0.6);
    }
  }

  /** Regular block: duller, heavier metal on metal — short low modes, a heavy knock, grit. */
  blockThud(): void {
    if (!this.ctx) return;
    const m = this.mix;
    const t = m.now;
    const d = m.em.c.in;
    const p = rand(0.93, 1.07);
    m.osc(d, t, 160, 60, 0.22, 1.5);
    m.noiseHit(d, t, 0.1, "bandpass", 850 * p, 0.9, 1.2);
    m.noiseHit(d, t, 0.012, "highpass", 1800, 0.7, 0.35, { attack: 0.0005 });
    m.noiseHit(d, t + 0.004, 0.07, "bandpass", 2600 * p, 2, 0.12, { to: 1600 });
    for (const [r, g, dec] of [[1, 0.06, 0.28], [2.41, 0.035, 0.18], [3.7, 0.02, 0.12]] as const) {
      const f = 470 * p * r;
      m.osc(d, t, f, f * 0.99, dec, g * 2.8, { verb: 0.15 });
      m.osc(d, t, f * 1.006, f, dec * 0.8, g * 1.6);
    }
  }

  /** Player's sword lands on the general: lacquered armour (plates clack) or cloth. */
  hitFlesh(armour = true): void {
    if (!this.ctx) return;
    const m = this.mix;
    const t = m.now;
    const d = m.em.b.in;
    // Slice.
    m.noiseHit(d, t, 0.12, "bandpass", 3800, 0.9, 1.4, { to: 1400 });
    // Meat.
    m.osc(d, t, 170, 55, 0.18, 2.4);
    m.noiseHit(d, t, 0.08, "lowpass", 600, 0.8, 2.2);
    if (armour) {
      // Lamellar plates: three quick bright clacks with short inharmonic rings.
      for (let i = 0; i < 3; i++) {
        const at = t + i * rand(0.008, 0.016);
        const f = rand(1100, 1700);
        m.osc(d, at, f, f, 0.09, 0.17, { verb: 0.1 });
        m.osc(d, at, f * 2.32, f * 2.3, 0.05, 0.08);
        m.noiseHit(d, at, 0.01, "bandpass", 3000, 1.5, 0.6);
      }
    } else {
      m.noiseHit(d, t, 0.16, "bandpass", 1200, 0.7, 0.5, { to: 500 });
    }
    if (Math.random() < 0.45) this.voice.bossGrunt(t + 0.03);
    m.duck(0.8, 0.03, 0.25);
  }

  /** Player takes a hit: cut through cloth, body blow, a pained breath. */
  hurt(): void {
    if (!this.ctx) return;
    const m = this.mix;
    const t = m.now;
    const d = m.em.p.in;
    m.noiseHit(d, t, 0.1, "bandpass", 3200, 0.9, 0.35, { to: 1200 });
    m.osc(d, t, 140, 45, 0.25, 0.8);
    m.noiseHit(d, t, 0.2, "lowpass", 800, 0.7, 0.55, { to: 250 });
    m.noiseHit(d, t, 0.14, "bandpass", 1300, 0.6, 0.2); // cloth
    this.voice.playerHurt(t + 0.02);
    m.duck(0.6, 0.05, 0.4);
  }

  /**
   * Sword swing: a swept blade whistle + air + cloth, varied per swing. `from` picks the fighter
   * (the general's are longer, lower, with a body rush and sometimes a kiai on heavy blows).
   */
  whoosh(heavy = false, from: "player" | "boss" = "player"): void {
    if (!this.ctx) return;
    const m = this.mix;
    const t = m.now;
    const boss = from === "boss";
    const d = boss ? m.em.b.in : m.em.p.in;
    const v = this.swingN++ % 3;
    const j = rand(0.9, 1.1) * (1 + (v - 1) * 0.07);
    const dur = (boss ? (heavy ? 0.46 : 0.32) : heavy ? 0.3 : 0.2) * rand(0.92, 1.08);
    const peakF = (boss ? (heavy ? 900 : 1300) : heavy ? 1700 : 2400) * j;
    const g = (boss ? (heavy ? 0.42 : 0.32) : heavy ? 0.32 : 0.24) * 1.6;
    // Blade: narrow swept band (the tonal "vwish").
    m.noiseHit(d, t, dur, "bandpass", peakF * 0.45, 4.5, g, { to: peakF, shape: 0.55, verb: 0.08 });
    // Air: wide band.
    m.noiseHit(d, t, dur * 1.1, "bandpass", peakF * 0.3, 0.8, g * 0.6, { to: peakF * 0.7, shape: 0.5 });
    // Cloth / sleeve flutter.
    m.noiseHit(d, t, dur * 0.8, "lowpass", 700, 0.7, g * 0.35, { shape: 0.3 });
    if (boss) {
      m.noiseHit(d, t, dur * 1.2, "lowpass", 260, 0.7, g * (heavy ? 0.9 : 0.5), { shape: 0.5, pink: true });
      if (heavy && Math.random() < 0.7) this.voice.bossKiai(t - 0.04, Math.random() < 0.4);
    } else if (Math.random() < (heavy ? 0.4 : 0.15)) {
      this.voice.playerAttack(t, heavy);
    }
  }

  /** The glint that marks a wind-up: a clean, high "shing". */
  glint(): void {
    if (!this.ctx) return;
    const m = this.mix;
    const t = m.now;
    const d = m.em.b.in;
    m.osc(d, t, 3520, 3520, 0.4, 0.07, { verb: 0.6 });
    m.osc(d, t + 0.02, 5274, 5274, 0.3, 0.04, { verb: 0.6 });
    m.osc(d, t, 3536, 3530, 0.35, 0.04);
    m.noiseHit(d, t, 0.14, "highpass", 6500, 0.7, 0.025, { shape: 0.3 });
  }

  /** Perilous warning: a dark brass stab with a low hit and a hiss (heard over everything). */
  peril(): void {
    if (!this.ctx) return;
    const m = this.mix;
    const ctx = m.ctx;
    const t = m.now;
    const d = m.em.c.in;
    for (const f of [98, 103.8, 146.8]) {
      const o = ctx.createOscillator();
      o.type = "sawtooth";
      o.frequency.value = f;
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.setValueAtTime(2600, t);
      lp.frequency.exponentialRampToValueAtTime(260, t + 0.7);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.1, t + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0005, t + 0.85);
      const s = ctx.createGain();
      s.gain.value = 0.6;
      o.connect(lp).connect(g).connect(d);
      g.connect(s).connect(m.verb);
      o.start(t);
      o.stop(t + 0.9);
      o.onended = () => {
        o.disconnect();
        lp.disconnect();
        g.disconnect();
        s.disconnect();
      };
    }
    m.noiseHit(d, t, 0.5, "bandpass", 5000, 0.8, 0.12, { to: 2000, verb: 0.3 });
    m.osc(d, t, 90, 48, 0.6, 0.9);
    // The bright sting that cuts through the drums.
    for (const [f, g] of [[1318, 0.18], [1975, 0.14], [2637, 0.1], [1324, 0.1]] as const) {
      m.osc(d, t + 0.005, f, f * 0.985, 0.8, g, { attack: 0.004, glide: 0.8, verb: 0.7 });
    }
    m.duck(0.3, 0.3, 0.7);
  }

  /** Posture break (`big`): deep o-daiko, a metal shatter and a whoosh. Small = a light drum hit. */
  drum(big = true): void {
    if (!this.ctx) return;
    const m = this.mix;
    const t = m.now;
    const d = m.em.c.in;
    if (!big) {
      m.osc(d, t, 150, 58, 0.35, 0.5, { glide: 0.05 });
      m.noiseHit(d, t, 0.08, "lowpass", 700, 0.7, 0.3);
      return;
    }
    m.osc(d, t, 100, 48, 1.4, 1.0, { glide: 0.08, verb: 0.2 });
    m.osc(d, t, 150, 62, 0.45, 0.4, { glide: 0.04 });
    m.noiseHit(d, t, 0.2, "lowpass", 500, 0.7, 0.55);
    m.noiseHit(d, t, 0.015, "highpass", 2000, 0.7, 0.5, { attack: 0.0005 });
    // Shatter: a spray of short inharmonic metal pings + a hiss.
    for (let i = 0; i < 12; i++) {
      const at = t + Math.random() * Math.random() * 0.09;
      const f = rand(1200, 4500);
      m.osc(d, at, f, f * 0.995, rand(0.08, 0.35), rand(0.012, 0.03), { verb: 0.4 });
    }
    m.noiseHit(d, t, 0.3, "highpass", 4500, 0.7, 0.06, { verb: 0.3 });
    m.grains(d, t + 0.01, 14, 0.18, 3000, 0.1, 2, 0.2);
    // Whoosh of the stagger, falling.
    m.noiseHit(d, t + 0.05, 0.75, "bandpass", 2200, 1.2, 0.25, { to: 260, verb: 0.3 });
    m.duck(0.3, 0.25, 1.2);
  }

  /** Finishing strike: deep boom, the blade in, ink spray, then the single shamisen pluck. */
  finisher(): void {
    if (!this.ctx) return;
    const m = this.mix;
    const t = m.now;
    const d = m.em.c.in;
    m.osc(d, t, 72, 46, 2.4, 1.0, { glide: 2.2, verb: 0.3 });
    m.osc(d, t, 144, 92, 1.2, 0.3, { glide: 1.1 });
    m.noiseHit(d, t, 0.45, "lowpass", 420, 0.6, 0.6, { to: 80 });
    m.noiseHit(d, t, 0.08, "bandpass", 2400, 0.8, 0.4, { to: 1200 });
    this.inkSpray(t + 0.02, 1);
    m.duck(0.15, 0.6, 2);
    this.pluck(t + 0.42, 0.9);
  }

  /** The single shamisen pluck (Karplus-Strong string, sawari buzz, skin body). */
  pluck(at?: number, gain = 0.8): void {
    if (!this.ctx) return;
    const t = at ?? this.mix.now;
    this.mix.play(this.mix.em.c.in, t, this.shamisen, 1, gain * 0.9, 0.5);
  }

  /** Wet ink spray: a dense-then-thinning scatter of liquid grains over a soft splash swell. */
  private inkSpray(t: number, k: number): void {
    const m = this.mix;
    const d = m.em.b.in;
    m.noiseHit(d, t, 0.45, "bandpass", 1800, 0.6, 0.22 * k, { to: 700, shape: 0.12, verb: 0.2 });
    m.grains(d, t, 26, 0.4, 2600, 0.14 * k, 1.5, 0.15);
    m.grains(d, t + 0.03, 10, 0.3, 900, 0.12 * k, 2);
  }

  /** Clay tile underfoot, with a snow crunch; `speed` m/s. */
  footstep(speed: number): void {
    if (!this.ctx) return;
    const m = this.mix;
    const t = m.now;
    const v = clamp(0.3 + speed / 10, 0.3, 0.9);
    this.step(m.em.p.in, t, v * 1.4, false);
  }

  private step(d: AudioNode, t: number, v: number, heavy: boolean): void {
    const m = this.mix;
    const p = rand(0.9, 1.1);
    m.noiseHit(d, t, 0.025, "bandpass", (heavy ? 1500 : 2300) * p, 2.2, v * 0.22);
    m.osc(d, t, (heavy ? 110 : 170) * p, heavy ? 45 : 80, heavy ? 0.12 : 0.06, v * (heavy ? 0.5 : 0.3));
    m.grains(d, t + 0.005, heavy ? 6 : 4, 0.05, 3600, v * 0.05, 1.5);
  }

  /**
   * Dodge: a body whoosh shaped by direction (forward = a rising push, back = a falling pull, sides = a
   * swept pass), a cloth rustle, and tile / snow footfalls. `dir` is optional (old calls stay valid).
   */
  dodge(dir: "forward" | "back" | "left" | "right" = "back"): void {
    if (!this.ctx) return;
    const m = this.mix;
    const t = m.now;
    const d = m.em.p.in;
    const j = rand(0.9, 1.1);
    const [f0, f1, shape, g] =
      dir === "forward" ? [420, 1500, 0.65, 0.2] : dir === "back" ? [1300, 380, 0.3, 0.17] : [600, 1200, 0.5, 0.18];
    m.noiseHit(d, t, rand(0.24, 0.3), "bandpass", f0 * j, 0.9, g, { to: f1 * j, shape });
    // Cloth rustle: overlapping soft flutters, never above ~1.5 kHz.
    for (let i = 0; i < 3; i++) m.noiseHit(d, t + i * rand(0.035, 0.06), rand(0.1, 0.16), "bandpass", rand(550, 1400), 0.9, rand(0.08, 0.12), { shape: 0.4 });
    this.step(d, t + 0.02, rand(0.5, 0.65), false);
    this.dodgeLand(0.22 + (dir === "forward" ? 0.04 : 0));
    if (Math.random() < 0.25) this.voice.playerEffort(t);
  }

  /** Dodge / roll landing (`delay` s from now): a tile footfall plus a soft snow scuff. */
  dodgeLand(delay = 0): void {
    if (!this.ctx) return;
    const m = this.mix;
    const t = m.now + delay;
    const d = m.em.p.in;
    this.step(d, t, rand(0.4, 0.55), false);
    m.noiseHit(d, t + 0.02, rand(0.14, 0.2), "bandpass", rand(2000, 2800), 0.8, 0.035);
  }

  /**
   * Near miss: his blade passes just by her — a tight airy swish (panned on the boss's side) and a
   * low, slow "time-slow" swell underneath; music + ambience dip for the moment.
   */
  nearMiss(): void {
    if (!this.ctx) return;
    const m = this.mix;
    const t = m.now;
    const j = rand(0.9, 1.1);
    m.noiseHit(m.em.b.in, t, rand(0.12, 0.16), "bandpass", 900 * j, 3, 0.34, { to: 2600 * j, shape: 0.6, verb: 0.15 });
    m.noiseHit(m.em.b.in, t, 0.14, "bandpass", 700 * j, 0.9, 0.16, { to: 1800 * j, shape: 0.55 });
    // Time-slow: two detuned low sines swelling in and sinking, with a soft reversed-air breath.
    const f = rand(92, 104);
    m.osc(m.em.c.in, t, f, f * 0.8, 0.9, 0.06, { attack: 0.25, glide: 0.9, verb: 0.3 });
    m.osc(m.em.c.in, t, f * 1.006, f * 0.8, 0.9, 0.04, { attack: 0.25, glide: 0.9 });
    m.noiseHit(m.em.c.in, t, 0.5, "lowpass", 500, 0.7, 0.05, { shape: 0.7, pink: true });
    m.duck(0.7, 0.2, 0.6);
  }

  /** Hit landed on the general: a crisp, meaty cut accent (layer it on `hitFlesh` for the big ones). */
  hitAccent(): void {
    if (!this.ctx) return;
    const m = this.mix;
    const t = m.now;
    const d = m.em.b.in;
    const j = rand(0.92, 1.08);
    m.noiseHit(d, t, 0.07, "bandpass", 2600 * j, 1.2, 0.7, { to: 1200 * j }); // the edge biting
    m.noiseHit(d, t, 0.004, "lowpass", 4000, 0.6, 0.35, { attack: 0.0004 }); // crisp front
    m.osc(d, t, 210 * j, 70, 0.12, 1.6); // meat
    m.noiseHit(d, t + 0.005, 0.1, "lowpass", 450, 0.9, 1.1, { to: 180 }); // wet body
    m.duck(0.8, 0.03, 0.25);
  }

  /** Soft chime when the general's posture bar is near breaking (quiet, round, varies a little). */
  postureWarn(): void {
    if (!this.ctx) return;
    const m = this.mix;
    const t = m.now;
    const f = 988 * [1, 1.122, 0.891][Math.floor(Math.random() * 3)];
    m.osc(m.em.c.in, t, f, f, 0.7, 0.045, { attack: 0.006, verb: 0.5 });
    m.osc(m.em.c.in, t, f * 2.01, f * 2.01, 0.35, 0.008, { attack: 0.006 });
    m.osc(m.em.c.in, t + 0.004, f * 0.5, f * 0.5, 0.5, 0.012, { attack: 0.01 });
  }

  /** Gourd-charge tick (HUD): a small hollow wooden tock. */
  gourdTick(): void {
    if (!this.ctx) return;
    const m = this.mix;
    const t = m.now;
    const f = rand(780, 880);
    m.osc(m.em.p.in, t, f, f * 0.8, 0.07, 0.26);
    m.osc(m.em.p.in, t, f * 2.7, f * 2.6, 0.03, 0.05);
    m.noiseHit(m.em.p.in, t, 0.015, "bandpass", 1600, 2, 0.12);
  }

  land(): void {
    if (!this.ctx) return;
    const m = this.mix;
    const t = m.now;
    const d = m.em.p.in;
    m.osc(d, t, 120, 45, 0.14, 0.5);
    this.step(d, t, 0.8, false);
    m.noiseHit(d, t + 0.01, 0.2, "bandpass", 2400, 0.7, 0.05); // snow puff
  }

  bossStep(): void {
    if (!this.ctx) return;
    const m = this.mix;
    const t = m.now;
    const d = m.em.b.in;
    this.step(d, t, 0.65, true);
    // Armour plates settling.
    for (let i = 0; i < 2; i++) {
      const f = rand(1400, 2400);
      m.osc(d, t + 0.02 + i * rand(0.01, 0.03), f, f, 0.05, 0.01);
    }
  }

  /** His leap lands: heavy impact on the tiles, shattering snow. */
  slam(): void {
    if (!this.ctx) return;
    const m = this.mix;
    const t = m.now;
    const d = m.em.b.in;
    m.osc(d, t, 90, 46, 0.6, 1.0, { glide: 0.3, verb: 0.2 });
    m.osc(d, t, 180, 92, 0.3, 0.3);
    m.noiseHit(d, t, 0.4, "lowpass", 700, 0.6, 0.6, { to: 120 });
    m.grains(d, t, 12, 0.12, 2000, 0.2, 1.4); // tiles
    m.noiseHit(d, t + 0.02, 0.5, "bandpass", 2200, 0.7, 0.07, { verb: 0.2 }); // snow
    m.duck(0.5, 0.1, 0.6);
  }

  deathSting(): void {
    if (!this.ctx) return;
    const t = this.mix.now;
    this.voice.playerHurt(t, true);
    this.music.death(t + 0.15);
    this.pluck(t + 0.5, 0.5);
    this.mix.duck(0.4, 0.2, 1.5);
  }

  uiStart(): void {
    if (!this.ctx) return;
    const m = this.mix;
    const t = m.now;
    m.noiseHit(m.em.c.in, t, 0.6, "bandpass", 300, 0.8, 0.2, { to: 2400, shape: 0.6, verb: 0.3 });
    this.music.odaiko(t + 0.05, 0.9);
  }

  // ------------------------------------------------------------------ abilities and menu

  /** 1: the curse takes the blade: a dark inhale, a low detuned drone that swells, a hiss of fire. */
  curseIgnite(): void {
    if (!this.ctx) return;
    const m = this.mix;
    const t = m.now;
    const d = m.em.p.in;
    m.noiseHit(d, t, 0.5, "bandpass", 260, 0.7, 0.22, { to: 1400, shape: 0.7, verb: 0.3 });
    for (const [f, dt] of [[73.4, 0], [110, 6], [146.8, -7], [220, 4]] as const) {
      m.osc(d, t + 0.05, f, f * 0.98, 1.4, 0.07, { type: "sawtooth", attack: 0.25, verb: 0.5, detune: dt });
    }
    m.noiseHit(d, t + 0.18, 0.9, "highpass", 3200, 0.6, 0.06, { verb: 0.2 });
    m.osc(d, t + 0.16, 880, 440, 0.6, 0.025, { type: "triangle", attack: 0.02, verb: 0.6 });
  }

  /** 1: a cursed cut landing: the fire bites (a hiss and a low throb under the flesh hit). */
  curseBite(): void {
    if (!this.ctx) return;
    const m = this.mix;
    const t = m.now;
    const d = m.em.c.in;
    m.noiseHit(d, t, 0.28, "bandpass", 2400, 0.8, 0.12, { to: 900, verb: 0.25 });
    m.osc(d, t, 98, 55, 0.4, 0.2, { type: "sawtooth", attack: 0.004, verb: 0.3 });
  }

  /** 2: the throw: cloth, a fuse spitting. */
  crackersThrow(): void {
    if (!this.ctx) return;
    const m = this.mix;
    const t = m.now;
    const d = m.em.p.in;
    m.noiseHit(d, t, 0.16, "bandpass", 1300, 0.9, 0.16, { to: 2600, shape: 0.4 });
    m.noiseHit(d, t + 0.02, 0.12, "highpass", 5200, 1.2, 0.08);
  }

  /** 2: one firecracker: a hard dry crack (loud, broadband, short), a paper snap and the roof's slap back. */
  crackerPop(big: boolean): void {
    if (!this.ctx) return;
    const m = this.mix;
    const t = m.now;
    const d = m.em.c.in;
    const g = big ? 1 : 0.62;
    const p = rand(0.85, 1.2);
    m.noiseHit(d, t, 0.012, "highpass", 900, 0.5, 0.9 * g, { attack: 0.0003 });
    m.noiseHit(d, t, 0.05, "bandpass", 2200 * p, 0.8, 0.45 * g, { verb: 0.45 });
    m.osc(d, t, 160 * p, 60, 0.08, 0.5 * g, { attack: 0.0005 });
    m.noiseHit(d, t + 0.006, 0.03, "bandpass", 5200 * p, 2, 0.12 * g);
    if (big) m.duck(0.35, 0.05, 0.3);
  }

  /** 3: into the feathers: a rush of wings (flutter grains), a low breath of shadow. */
  crowDive(): void {
    if (!this.ctx) return;
    const m = this.mix;
    const t = m.now;
    const d = m.em.p.in;
    for (let i = 0; i < 9; i++) m.noiseHit(d, t + i * 0.028 + rand(0, 0.01), 0.05, "bandpass", rand(700, 1400), 1.4, 0.13 * (1 - i / 11), { verb: 0.2 });
    m.noiseHit(d, t, 0.42, "lowpass", 600, 0.7, 0.18, { to: 180, verb: 0.35 });
    m.osc(d, t, 330, 180, 0.35, 0.03, { type: "triangle", verb: 0.5 });
  }

  /** 3: out at his back: a single hard wingbeat and a cloth snap. */
  crowAppear(): void {
    if (!this.ctx) return;
    const m = this.mix;
    const t = m.now;
    const d = m.em.p.in;
    m.noiseHit(d, t, 0.09, "bandpass", 900, 0.9, 0.26, { verb: 0.25 });
    m.noiseHit(d, t + 0.05, 0.08, "bandpass", 1600, 1.1, 0.14);
  }

  /** An ability key while it is still recharging: a muted wooden tick. */
  denied(): void {
    if (!this.ctx) return;
    const m = this.mix;
    const t = m.now;
    m.osc(m.em.p.in, t, 240, 200, 0.06, 0.12, { type: "triangle" });
  }

  /** Menu: a soft koto pluck on hover / move. */
  uiMove(): void {
    if (!this.ctx) return;
    this.pluck(this.mix.now, 0.32);
  }

  /** Menu: a choice made: a bright pluck and a small bell. */
  uiSelect(): void {
    if (!this.ctx) return;
    const m = this.mix;
    const t = m.now;
    this.pluck(t, 0.6);
    m.osc(m.em.c.in, t + 0.01, 1318.5, 1318.5, 1.1, 0.035, { attack: 0.003, verb: 0.5 });
    m.osc(m.em.c.in, t + 0.01, 1977, 1977, 0.7, 0.012, { attack: 0.003, verb: 0.5 });
  }

  /** Take-off: cloth snap and a push off the tiles. */
  jump(): void {
    if (!this.ctx) return;
    const m = this.mix;
    const t = m.now;
    const d = m.em.p.in;
    m.noiseHit(d, t, 0.14, "bandpass", 900, 0.9, 0.16, { to: 2200, shape: 0.3 });
    this.step(d, t, 0.6, false);
    if (Math.random() < 0.4) this.voice.playerEffort(t);
  }

  /** Gourd unstoppered: a wooden cork "thok", air rush, liquid slosh. */
  drink(): void {
    if (!this.ctx) return;
    const m = this.mix;
    const t = m.now;
    const d = m.em.p.in;
    m.osc(d, t, 380, 900, 0.05, 0.22, { glide: 0.03 });
    m.noiseHit(d, t, 0.03, "bandpass", 1800, 3, 0.18);
    m.noiseHit(d, t + 0.02, 0.12, "highpass", 3000, 0.7, 0.05);
    m.noiseHit(d, t + 0.1, 0.25, "bandpass", 500, 5, 0.1, { to: 800, shape: 0.4 });
  }

  /** The swallow: three throat gulps with bubbles, a warm healing swell, then a breath. */
  sip(): void {
    if (!this.ctx) return;
    const m = this.mix;
    const t = m.now;
    const d = m.em.p.in;
    for (let i = 0; i < 3; i++) {
      const at = t + i * 0.12;
      m.osc(d, at, 240 - i * 15, 110, 0.08, 0.3);
      m.osc(d, at + 0.03, 700, 1300, 0.025, 0.06);
      m.noiseHit(d, at, 0.06, "bandpass", 450, 4, 0.08);
    }
    m.osc(d, t + 0.25, 440, 440, 0.9, 0.025, { attack: 0.15, verb: 0.6 });
    m.osc(d, t + 0.27, 660, 660, 0.8, 0.015, { attack: 0.15, verb: 0.6 });
    this.voice.playerExhale(t + 0.45);
  }

  gourdEmpty(): void {
    if (!this.ctx) return;
    const m = this.mix;
    const t = m.now;
    m.osc(m.em.p.in, t, 700, 420, 0.05, 0.2);
    m.noiseHit(m.em.p.in, t, 0.03, "bandpass", 1800, 2, 0.1);
  }

  /** Resurrection: a heartbeat accelerating under an eerie rising tone, into a drum and the string. */
  revive(): void {
    if (!this.ctx) return;
    const m = this.mix;
    const t = m.now;
    const d = m.em.p.in;
    for (const at of [0, 0.75, 1.3]) {
      m.osc(d, t + at, 62, 45, 0.16, 0.3);
      m.osc(d, t + at + 0.2, 55, 45, 0.12, 0.18);
    }
    for (const [f, dt] of [[220, 0], [221.8, 0], [330, 0.1]] as const) {
      m.osc(d, t + dt, f, f * 2, 1.7, 0.035, { attack: 1.1, glide: 1.6, verb: 0.8 });
    }
    m.noiseHit(d, t, 1.6, "bandpass", 200, 0.7, 0.2, { to: 3200, shape: 0.9, verb: 0.4 });
    this.drum(false);
    m.osc(d, t + 1.6, 90, 48, 0.8, 0.45);
    this.pluck(t + 1.62, 0.5);
    m.duck(0.5, 1.4, 1);
  }

  /** Mikiri: her foot stamps his blade into the tiles — a heavy wood / metal crunch over a bass hit. */
  mikiri(): void {
    if (!this.ctx) return;
    const m = this.mix;
    const t = m.now;
    const d = m.em.c.in;
    const j = rand(0.94, 1.06);
    // Bass hit.
    m.osc(d, t, 120 * j, 48, 0.5, 1.0, { glide: 0.25, verb: 0.2 });
    m.osc(d, t, 240 * j, 96, 0.2, 0.3);
    // Wood: tile / beam crunch (a low knock + dense low grains).
    m.osc(d, t, 330 * j, 250, 0.08, 0.35);
    m.grains(d, t, 12, 0.07, 1300 * j, 0.28, 1.2);
    m.noiseHit(d, t, 0.16, "bandpass", 900 * j, 0.8, 0.45, { to: 300 });
    // Metal: the blade pinned — a short, damped scrape and a low ring (no piercing highs).
    m.noiseHit(d, t + 0.01, 0.22, "bandpass", 2600 * j, 1.4, 0.1, { to: 1500, verb: 0.25 });
    for (const [r, g, dec] of [[1, 0.05, 0.6], [2.76, 0.025, 0.35]] as const) {
      const f = 560 * j * r;
      m.osc(d, t, f, f * 0.995, dec, g, { verb: 0.3 });
      m.osc(d, t, f * 1.005, f, dec * 0.8, g * 0.6);
    }
    this.drum(false);
    this.voice.playerAttack(t, true);
    m.duck(0.45, 0.12, 0.6);
  }

  /** Kick off his body (`head`: off his helmet during a sweep). */
  kick(head: boolean): void {
    if (!this.ctx) return;
    const m = this.mix;
    const t = m.now;
    const d = m.em.b.in;
    m.osc(d, t, head ? 180 : 140, 50, head ? 0.25 : 0.16, head ? 0.8 : 0.55);
    m.noiseHit(d, t, 0.08, "bandpass", head ? 1500 : 900, 0.8, 0.3);
    if (head) {
      for (const r of [1, 2.2, 3.4]) m.osc(d, t, 720 * r, 710 * r, 0.3 / r, 0.05 / r, { verb: 0.3 });
    }
    this.voice.playerAttack(t, true);
    this.voice.bossGrunt(t + 0.05);
  }

  /** Grab closes: armour lurch, cloth, a grunt. */
  grab(): void {
    if (!this.ctx) return;
    const m = this.mix;
    const t = m.now;
    const d = m.em.c.in;
    m.noiseHit(d, t, 0.22, "bandpass", 420, 0.8, 0.35, { to: 180 });
    m.osc(d, t, 110, 55, 0.2, 0.9);
    for (let i = 0; i < 3; i++) m.osc(d, t + i * 0.02, rand(1300, 2200), 1300, 0.05, 0.015);
    this.voice.bossKiai(t, false);
    this.voice.playerHurt(t + 0.08);
  }

  throwSlam(): void {
    if (!this.ctx) return;
    const m = this.mix;
    const t = m.now;
    const d = m.em.p.in;
    m.osc(d, t, 95, 46, 0.6, 1.0, { glide: 0.3 });
    m.osc(d, t, 190, 92, 0.3, 0.3);
    m.noiseHit(d, t, 0.4, "lowpass", 600, 0.6, 0.6, { to: 120 });
    m.grains(d, t, 10, 0.1, 2200, 0.18, 1.4);
    m.noiseHit(d, t + 0.02, 0.4, "bandpass", 2200, 0.7, 0.06);
    this.voice.playerHurt(t + 0.03, true);
    m.duck(0.45, 0.15, 0.8);
  }

  /** Player posture broken: a crunch of the guard caving, a sinking drum, stumbling feet. */
  guardBreak(): void {
    if (!this.ctx) return;
    const m = this.mix;
    const t = m.now;
    const d = m.em.p.in;
    m.grains(d, t, 8, 0.06, 1400, 0.35, 0.9);
    m.noiseHit(d, t, 0.3, "bandpass", 380, 0.8, 0.45, { to: 120 });
    m.osc(d, t, 520, 360, 0.4, 0.05, { type: "triangle", verb: 0.3 });
    m.osc(d, t, 120, 40, 0.5, 0.8, { glide: 0.2 });
    this.step(d, t + 0.2, 0.6, false);
    this.step(d, t + 0.42, 0.5, false);
    this.voice.playerHurt(t + 0.04, true);
    m.duck(0.5, 0.1, 0.7);
  }

  /** First-marker deathblow: impact, ink spray, one pluck. */
  deathblow(): void {
    if (!this.ctx) return;
    const m = this.mix;
    const t = m.now;
    const d = m.em.c.in;
    m.osc(d, t, 80, 48, 1.0, 0.95, { glide: 0.8, verb: 0.2 });
    m.osc(d, t, 160, 96, 0.5, 0.3, { glide: 0.4 });
    m.noiseHit(d, t, 0.3, "lowpass", 400, 0.6, 0.55, { to: 80 });
    m.noiseHit(d, t, 0.07, "bandpass", 2600, 0.8, 0.35, { to: 1200 });
    this.inkSpray(t + 0.02, 0.8);
    this.voice.bossGrunt(t + 0.05);
    m.duck(0.3, 0.4, 1.2);
    this.pluck(t + 0.3, 0.8);
  }

  /** He rises for his second life: battle cry over a growl and a drum. */
  bossRise(): void {
    if (!this.ctx) return;
    const m = this.mix;
    const ctx = m.ctx;
    const t = m.now;
    const d = m.em.b.in;
    for (const f of [55, 82.4, 110.6]) {
      const o = ctx.createOscillator();
      o.type = "sawtooth";
      o.frequency.setValueAtTime(f * 0.8, t);
      o.frequency.exponentialRampToValueAtTime(f, t + 1.1);
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.setValueAtTime(160, t);
      lp.frequency.exponentialRampToValueAtTime(1100, t + 1.1);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.07, t + 0.9);
      g.gain.exponentialRampToValueAtTime(0.0005, t + 1.9);
      o.connect(lp).connect(g).connect(d);
      o.start(t);
      o.stop(t + 1.95);
      o.onended = () => {
        o.disconnect();
        lp.disconnect();
        g.disconnect();
      };
    }
    this.voice.bossBattleCry(t + 0.1);
    this.music.odaiko(t, 1.1, true);
    this.music.odaiko(t + 0.9, 1, true);
    m.duck(0.4, 1.2, 1.2);
  }

  // ------------------------------------------------------------------ charged cut

  private chargeStart(): void {
    const m = this.mix;
    const ctx = m.ctx;
    const t = m.now;
    const out = ctx.createGain();
    out.gain.setValueAtTime(0, t);
    out.gain.linearRampToValueAtTime(0.12, t + 0.5);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(200, t);
    lp.frequency.exponentialRampToValueAtTime(2400, t + 0.7);
    lp.Q.value = 4;
    lp.connect(out).connect(m.em.p.in);
    const srcs: AudioScheduledSourceNode[] = [];
    for (const [f, type, dt] of [[110, "sawtooth", 0], [110.7, "sawtooth", 0], [220, "sine", 0], [880, "sine", 0]] as const) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(f, t);
      o.frequency.exponentialRampToValueAtTime(f * 1.5, t + 0.7);
      o.detune.value = dt;
      o.connect(lp);
      o.start(t);
      srcs.push(o);
    }
    this.charge = { nodes: [lp], srcs, out };
  }

  private chargeStop(): void {
    const c = this.charge;
    if (!c) return;
    this.charge = null;
    const m = this.mix;
    const t = m.now;
    c.out.gain.cancelScheduledValues(t);
    c.out.gain.setValueAtTime(c.out.gain.value, t);
    c.out.gain.linearRampToValueAtTime(0, t + 0.04);
    for (const s of c.srcs) s.stop(t + 0.06);
    c.srcs[0].onended = () => {
      for (const s of c.srcs) s.disconnect();
      for (const n of c.nodes) n.disconnect();
      c.out.disconnect();
    };
    // Release: a bright snap as the cut lets go.
    m.noiseHit(m.em.p.in, t, 0.05, "highpass", 3000, 0.7, 0.25);
    m.osc(m.em.p.in, t, 2200, 1500, 0.25, 0.03, { verb: 0.4 });
  }

  // ------------------------------------------------------------------ music (kept for call sites)

  /** Drums on / off: the scene state drives the score; this only mutes the drums between fights. */
  setTaiko(on: boolean): void {
    if (!this.ctx) return;
    if (!on && this.sceneName === "fight") return;
    if (on && this.sceneName !== "fight") this.music.setScene("fight");
  }

  // ------------------------------------------------------------------ offline renders (tools)

  /** For tools/audio-render.mjs: the music's scene switch without the game. */
  debugScene(s: string): void {
    if (this.ctx) {
      this.sceneName = s;
      this.music.setScene(s);
    }
  }
}
