/**
 * Adaptive score: one composed theme, arranged per scene, scheduled ahead on a 16th-note grid.
 *
 *   The theme   — eight bars in miyako-bushi on D (D Eb G A Bb): a rising fifth that sighs back
 *                 down (D A Bb A G | A——), its answer an octave up (D G A G Eb | D——), and a
 *                 cadence home. Harmony every two bars: D · Bb · G · A → D (pad + low koto).
 *   title       — slow (58 bpm). Shakuhachi plays the theme over a dark string pad and a soft
 *                 o-daiko heartbeat; on the repeat the koto answers it, quietly. Calm, but uneasy.
 *   fight       — the same theme at the fight's tempo. Drums build by `intensity` (0..1):
 *                 o-daiko → nagado syncopation → shime 8ths and fills; a low koto ostinato drives
 *                 the second half of each 16-bar cycle.
 *   phase 2     — a bigger layer: low brass doubles the theme an octave down, brass stabs on the
 *                 bar, the ostinato goes to 16ths, the heavy o-daiko pattern every bar.
 *   finisher    — the drums cut; one held low chord.
 *   victory     — drum roll into one hit, then a quiet coda: the theme's last bar on the koto and
 *                 one long flute note over the D chord, fading to the wind.
 */
import type { Mix } from "./mix";
import { KOTO, makeString } from "./synth";

const SCALE = [0, 1, 5, 7, 8]; // semitones from D
const D4 = 293.66;
const D3 = D4 / 2;
const note = (deg: number) => D4 * Math.pow(2, (SCALE[((deg % 5) + 5) % 5] + 12 * Math.floor(deg / 5)) / 12);
const semi = (f: number, s: number) => f * Math.pow(2, s / 12);

// 16-step drum patterns; values = velocity.
const ODAIKO = [1, 0, 0, 0, 0, 0, 0, 0, 0.8, 0, 0, 0, 0, 0, 0.45, 0];
const ODAIKO2 = [1, 0, 0, 0.5, 0, 0, 0.7, 0, 0.9, 0, 0, 0.45, 0, 0, 0.75, 0.5];
const NAGADO = [0, 0, 0.6, 0, 0.8, 0, 0, 0.5, 0, 0, 0.6, 0, 0.8, 0, 0, 0];
const SHIME = [0.7, 0, 0.35, 0, 0.6, 0, 0.35, 0.3, 0.7, 0, 0.35, 0, 0.6, 0.3, 0.45, 0.35];
const KA = [0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0, 0, 0, 0.5, 0, 0.35, 0];

/** The theme: per bar, [scale degree (0 = D4) or null for a rest, length in 16ths]; each bar = 16. */
const THEME: [number | null, number][][] = [
  [[0, 4], [3, 4], [4, 2], [3, 2], [2, 4]],
  [[3, 12], [null, 4]],
  [[5, 4], [6, 2], [5, 2], [4, 4], [3, 4]],
  [[2, 2], [3, 2], [1, 4], [0, 8]],
  [[5, 4], [7, 4], [8, 2], [7, 2], [6, 4]],
  [[5, 12], [null, 4]],
  [[4, 4], [3, 2], [4, 2], [5, 4], [6, 2], [5, 2]],
  [[3, 3], [2, 1], [1, 4], [0, 8]],
];
/** Theme notes by position in the 8-bar phrase (bar * 16 + step) → [degree, length in 16ths]. */
const THEME_AT = new Map<number, [number, number]>();
THEME.forEach((bar, b) => {
  let s = 0;
  for (const [d, len] of bar) {
    if (d !== null) THEME_AT.set(b * 16 + s, [d, len]);
    s += len;
  }
});

/** Harmony, one chord per two bars: root (semitones from D3) and its voicing (semitones above). */
const CHORDS: { root: number; iv: number[] }[] = [
  { root: 0, iv: [0, 7, 12] }, // D  (D A D)
  { root: -4, iv: [0, 4, 12] }, // Bb (Bb D Bb)
  { root: -7, iv: [0, 3, 7] }, // G  (G Bb D)
  { root: -5, iv: [0, 5, 12] }, // A  (A D A): pulls home
];

export type Scene = "title" | "fight" | "dying" | "defeat" | "deathblow" | "finisher" | "victory" | string;

export class Music {
  private out: GainNode;
  private drums: GainNode;
  private flute: GainNode;
  private strings: GainNode;
  private brass: GainNode;
  private koto: AudioBuffer;
  private drone: GainNode;
  private droneOsc: OscillatorNode[] = [];
  private next = 0;
  private step = 0;
  private scene: Scene = "";
  tempo = 76;
  intensity = 0;
  phase = 1;

  constructor(private readonly mix: Mix) {
    const ctx = mix.ctx;
    this.out = ctx.createGain();
    this.out.gain.value = 1;
    this.out.connect(mix.music);
    const bus = (g: number, verb: number) => {
      const n = ctx.createGain();
      n.gain.value = g;
      n.connect(this.out);
      if (verb > 0) {
        const s = ctx.createGain();
        s.gain.value = verb;
        n.connect(s).connect(mix.musicVerb);
      }
      return n;
    };
    this.drums = bus(0, 0.25);
    this.flute = bus(0.8, 0);
    this.strings = bus(1, 0.7);
    this.brass = bus(0, 0.45);
    this.koto = makeString(ctx, 293.66, KOTO);
    // Drone: D2 + A2, slowly beating, low-passed; swells under the title / defeat.
    this.drone = ctx.createGain();
    this.drone.gain.value = 0;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 420;
    this.drone.connect(lp).connect(this.out);
    for (const [f, d] of [[73.42, 0], [73.42, 7], [110, -4], [146.8, 3]] as const) {
      const o = ctx.createOscillator();
      o.type = "triangle";
      o.frequency.value = f;
      o.detune.value = d;
      o.connect(this.drone);
      o.start();
      this.droneOsc.push(o);
    }
  }

  /** Beats per minute the score actually plays at: the fight's tempo, compressed so the theme stays a melody. */
  private get bpm(): number {
    if (this.scene === "title") return 58;
    return 70 + Math.max(0, this.tempo - 76) * 0.55;
  }

  setScene(s: Scene): void {
    if (s === this.scene) return;
    const prev = this.scene;
    this.scene = s;
    const t = this.mix.now;
    const fight = s === "fight";
    const title = s === "title";
    // Stings play with the fight over: nothing to sit under, so they come up.
    this.out.gain.setTargetAtTime(s === "victory" || s === "defeat" || s === "dying" ? 2 : 1, t, 0.05);
    // On the title the drums are only a soft heartbeat (see stepAt).
    this.drums.gain.setTargetAtTime(fight || title ? 1 : 0, t, fight ? 0.3 : 0.12);
    this.strings.gain.setTargetAtTime(fight || title ? 1 : 0.6, t, 0.8);
    if (!fight) this.brass.gain.setTargetAtTime(0, t, 0.15);
    const drone = title ? 0.045 : s === "defeat" ? 0.08 : fight ? 0.03 : s === "finisher" || s === "deathblow" ? 0.06 : 0.02;
    this.drone.gain.setTargetAtTime(drone, t, 1.2);
    if ((fight && prev !== "fight") || title) {
      this.next = t + (title ? 1.2 : 0.12);
      this.step = 0;
    }
    if (s === "finisher" && prev !== "finisher") this.pad(t + 0.05, CHORDS[0], 7, 0.05, 380);
    if (s === "victory") this.victory(t + 0.35);
    if (s === "defeat") this.defeat(t + 0.2);
  }

  update(): void {
    const t = this.mix.now;
    const ahead = t + 0.16;
    if (this.scene !== "fight" && this.scene !== "title") return;
    if (this.next < t - 0.3) this.next = t + 0.02; // resumed after a stall: don't burst-schedule
    while (this.next < ahead) {
      this.stepAt(this.next, this.step);
      this.step++;
      this.next += 60 / this.bpm / 4;
    }
  }

  // ------------------------------------------------------------------ the arrangement

  private stepAt(t: number, i: number): void {
    const s = i % 16;
    const bar = Math.floor(i / 16);
    const b8 = bar % 8;
    const cycle = Math.floor(bar / 8);
    const sec = 60 / this.bpm / 4;
    const chord = CHORDS[b8 >> 1];
    const title = this.scene === "title";
    const p2 = this.phase === 2 && !title;
    const L = title ? 0 : this.intensity;

    // Harmony: a pad per chord (two bars), darker and lower on the title.
    if (s === 0 && b8 % 2 === 0) this.pad(t, chord, sec * 32 + 0.3, title ? 0.032 : p2 ? 0.04 : 0.026, title ? 520 : p2 ? 1100 : 760);

    if (title) {
      // Heartbeat: lub-dub every other bar, far off.
      if (b8 % 2 === 0 && s === 0) this.odaiko(t, 0.32);
      if (b8 % 2 === 0 && s === 3) this.odaiko(t, 0.18);
      const ev = THEME_AT.get(b8 * 16 + s);
      if (ev) {
        const dur = ev[1] * sec;
        // First time the flute; the repeat is the koto alone, quieter, with a breath of flute on long notes.
        if (cycle % 2 === 0) this.shakuhachi(t, note(ev[0]), dur * 0.96, 0.21);
        else {
          this.kotoNote(t, ev[0], 0.42);
          if (ev[1] >= 8) this.shakuhachi(t + sec, note(ev[0]), dur * 0.8, 0.09);
        }
      }
      // A low koto pulse on the chord root, once a bar.
      if (s === 8) this.kotoHz(t, semi(D3, chord.root) / 2, 0.3);
      return;
    }

    this.drumStep(t, i);

    // The theme: on the first half of each 16-bar cycle; in phase 2 every time, doubled by low brass.
    const ev = THEME_AT.get(b8 * 16 + s);
    if (ev && (cycle % 2 === 0 || p2)) {
      const dur = ev[1] * sec;
      this.shakuhachi(t, note(ev[0]), dur * 0.95, p2 ? 0.2 : 0.18 - L * 0.03);
      if (p2) this.horn(t, note(ev[0]) / 2, dur * 0.95, 0.06);
      else if (L < 0.5 && ev[1] >= 8) this.kotoNote(t, ev[0] - 5, 0.3);
    }

    // Low koto ostinato on the chord: 8ths in the answer half once the fight warms, 16ths in phase 2.
    const ost = p2 || (cycle % 2 === 1 && L > 0.15) || L > 0.55;
    if (ost && (p2 || L > 0.7 || s % 2 === 0)) {
      const k = (p2 || L > 0.7 ? s : s >> 1) % 4;
      const iv = chord.iv[[0, 1, 2, 1][k]];
      this.kotoHz(t, semi(D3, chord.root + iv), (s % 4 === 0 ? 0.34 : 0.22) * (p2 ? 1 : 0.85));
    }

    // Phase 2: brass stabs on the bar (root + fifth), a pushed one before the half.
    if (p2 && (s === 0 || s === 10)) {
      const f = semi(D3, chord.root) / 2;
      const v = s === 0 ? 0.13 : 0.08;
      this.horn(t, f, sec * (s === 0 ? 3 : 2), v, true);
      this.horn(t, f * 1.5, sec * (s === 0 ? 3 : 2), v * 0.6, true);
    }
  }

  // ------------------------------------------------------------------ drums

  private drumStep(t: number, i: number): void {
    const s = i % 16;
    const bar = Math.floor(i / 16);
    const L = this.intensity;
    const p2 = this.phase === 2;
    const hum = () => t + (Math.random() - 0.5) * 0.008;
    // Denser drums play a little softer each, so the ensemble thickens without swamping the steel.
    const k = 1 - 0.25 * L;
    const od = L > 0.62 || p2 ? ODAIKO2 : ODAIKO;
    if (od[s]) this.odaiko(hum(), od[s] * (0.75 + L * 0.3) * k);
    const nag = p2 ? Math.max(0.6, L) : L;
    if (nag > 0.5 && NAGADO[s]) this.nagado(hum(), NAGADO[s] * Math.min(1, (nag - 0.5) * 3) * k);
    const sh = p2 ? Math.max(0.8, L) : L;
    if (sh > 0.68 && SHIME[s]) this.shime(hum(), SHIME[s] * Math.min(1, (sh - 0.68) * 3.5) * k);
    if (L > 0.45 && KA[s]) this.ka(hum(), KA[s]);
    // Every 4th bar ends with a fill once the fight heats up; every 8th, a big one into the theme.
    if (L > 0.72 && bar % 4 === 3 && s >= 12) this.shime(hum() + 60 / this.bpm / 8, 0.4);
    if ((L > 0.5 || p2) && bar % 8 === 7 && s === 12) this.odaiko(hum(), 0.7 * k);
  }

  /** O-daiko: huge low membrane (fundamental + 1.59 / 2.14 modes), skin slap, stick. */
  odaiko(t: number, v: number, big = false): void {
    const m = this.mix;
    const f = big ? 52 : 62 + Math.random() * 4;
    const d = this.drums;
    const g = 0.55 * v * (big ? 1.4 : 1);
    m.osc(d, t, f * 1.7, f, big ? 1.8 : 1.1, g, { glide: 0.04 });
    m.osc(d, t, f * 1.59 * 1.3, f * 1.59, 0.35, g * 0.35, { glide: 0.03 });
    m.osc(d, t, f * 2.14, f * 2.1, 0.18, g * 0.2);
    m.noiseHit(d, t, 0.09, "lowpass", 900, 0.7, g * 0.5);
    m.noiseHit(d, t, 0.012, "bandpass", 2600, 1.2, g * 0.25);
  }

  private nagado(t: number, v: number): void {
    const m = this.mix;
    const f = 118 + Math.random() * 6;
    const g = 0.32 * v;
    m.osc(this.drums, t, f * 1.5, f, 0.4, g, { glide: 0.025 });
    m.osc(this.drums, t, f * 1.59, f * 1.57, 0.14, g * 0.3);
    m.noiseHit(this.drums, t, 0.05, "bandpass", 1100, 0.8, g * 0.45);
  }

  private shime(t: number, v: number): void {
    const m = this.mix;
    const g = 0.2 * v;
    m.osc(this.drums, t, 520, 430, 0.1, g, { glide: 0.01 });
    m.noiseHit(this.drums, t, 0.035, "bandpass", 3200, 1.4, g * 0.9);
  }

  /** Rim "ka": dry wood click. */
  private ka(t: number, v: number): void {
    this.mix.noiseHit(this.drums, t, 0.022, "bandpass", 2300, 5, 0.22 * v);
    this.mix.osc(this.drums, t, 1850, 1700, 0.03, 0.05 * v);
  }

  // ------------------------------------------------------------------ voices

  /**
   * Shakuhachi: sine + a little 2nd/3rd harmonic, breath noise band-passed at the pitch, a chiff,
   * a scoop up from below (meri → kari), delayed vibrato and a breathy release.
   */
  shakuhachi(t: number, f: number, dur: number, gain: number): void {
    const ctx = this.mix.ctx;
    const env = ctx.createGain();
    const att = Math.min(0.12, dur * 0.3);
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(gain, t + att);
    env.gain.setTargetAtTime(gain * 0.75, t + att, dur * 0.5);
    env.gain.setTargetAtTime(0, t + dur, 0.1);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 3200;
    env.connect(lp).connect(this.flute);
    const send = ctx.createGain();
    send.gain.value = 0.9;
    lp.connect(send).connect(this.mix.musicVerb);
    // Long notes scoop up from below; short ones barely.
    const scoop = dur > 0.6 ? 0.94 : 0.985;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(f * scoop, t);
    o.frequency.exponentialRampToValueAtTime(f, t + Math.min(0.16, dur * 0.4));
    const o2 = ctx.createOscillator();
    o2.type = "triangle";
    o2.frequency.setValueAtTime(f * scoop * 2, t);
    o2.frequency.exponentialRampToValueAtTime(f * 2, t + Math.min(0.16, dur * 0.4));
    const o2g = ctx.createGain();
    o2g.gain.value = 0.12;
    o.connect(env);
    o2.connect(o2g).connect(env);
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 4.8 + Math.random();
    const lg = ctx.createGain();
    lg.gain.setValueAtTime(0, t);
    lg.gain.linearRampToValueAtTime(0, t + Math.min(0.5, dur * 0.4));
    lg.gain.linearRampToValueAtTime(14, t + dur);
    lfo.connect(lg);
    lg.connect(o.detune);
    lg.connect(o2.detune);
    const n = ctx.createBufferSource();
    n.buffer = this.mix.noise;
    n.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = f;
    bp.Q.value = 9;
    const ng = ctx.createGain();
    ng.gain.value = 1.6;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 1800;
    const hg = ctx.createGain();
    hg.gain.value = 0.05;
    n.connect(bp).connect(ng).connect(env);
    n.connect(hp).connect(hg).connect(env);
    // Chiff.
    this.mix.noiseHit(this.flute, t, 0.08, "bandpass", f * 3, 3, gain * 0.35);
    const end = t + dur + 0.6;
    for (const s of [o, o2, lfo, n]) {
      s.start(t);
      s.stop(end);
    }
    o.onended = () => {
      for (const x of [o, o2, lfo, n, o2g, lg, bp, ng, hp, hg, env, lp, send]) x.disconnect();
    };
  }

  /** Koto on a theme degree (0 = D4). */
  kotoNote(t: number, deg: number, gain: number): void {
    this.kotoHz(t, note(deg), gain);
  }

  private kotoHz(t: number, f: number, gain: number): void {
    this.mix.play(this.flute, t, this.koto, f / 293.66, gain, 0.6, this.mix.musicVerb);
  }

  /** String pad: two detuned saws per voice, low-passed, slow swell and release. */
  private pad(t: number, chord: { root: number; iv: number[] }, dur: number, gain: number, cut: number): void {
    const ctx = this.mix.ctx;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + Math.min(1.2, dur * 0.3));
    g.gain.setTargetAtTime(0, t + dur - Math.min(1, dur * 0.25), 0.35);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = cut;
    lp.Q.value = 0.4;
    g.connect(lp).connect(this.strings);
    const oscs: OscillatorNode[] = [];
    for (const iv of chord.iv) {
      for (const d of [-7, 6]) {
        const o = ctx.createOscillator();
        o.type = "sawtooth";
        o.frequency.value = semi(D3, chord.root + iv);
        o.detune.value = d;
        o.connect(g);
        o.start(t);
        o.stop(t + dur + 1.2);
        oscs.push(o);
      }
    }
    oscs[0].onended = () => {
      for (const o of oscs) o.disconnect();
      g.disconnect();
      lp.disconnect();
    };
  }

  /** Low brass: saw + square sub through a filter that opens on the attack (a stab when `stab`). */
  private horn(t: number, f: number, dur: number, gain: number, stab = false): void {
    const ctx = this.mix.ctx;
    this.brass.gain.setTargetAtTime(1, t, 0.05);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + (stab ? 0.025 : 0.08));
    g.gain.setTargetAtTime(gain * (stab ? 0.35 : 0.8), t + 0.1, stab ? 0.12 : dur * 0.5);
    g.gain.setTargetAtTime(0, t + dur, 0.08);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.Q.value = 1.2;
    lp.frequency.setValueAtTime(240, t);
    lp.frequency.linearRampToValueAtTime(stab ? 1500 : 1000, t + 0.05);
    lp.frequency.setTargetAtTime(stab ? 380 : 600, t + 0.06, stab ? 0.1 : 0.4);
    g.connect(lp).connect(this.brass);
    const a = ctx.createOscillator();
    a.type = "sawtooth";
    a.frequency.value = f;
    const b = ctx.createOscillator();
    b.type = "sawtooth";
    b.frequency.value = f;
    b.detune.value = 9;
    const c = ctx.createOscillator();
    c.type = "square";
    c.frequency.value = f / 2;
    const cg = ctx.createGain();
    cg.gain.value = 0.35;
    a.connect(g);
    b.connect(g);
    c.connect(cg).connect(g);
    const end = t + dur + 0.5;
    for (const o of [a, b, c]) {
      o.start(t);
      o.stop(end);
    }
    a.onended = () => {
      for (const x of [a, b, c, cg, g, lp]) x.disconnect();
    };
  }

  // ------------------------------------------------------------------ stings

  private victory(t: number): void {
    // Rolling o-daiko crescendo into one huge hit, koto rising on the in-scale, a held flute note.
    for (let i = 0; i < 7; i++) this.odaiko(t + i * 0.11 * (1 - i * 0.06), 0.35 + i * 0.08);
    const hit = t + 0.72;
    this.odaiko(hit, 1.2, true);
    for (let i = 0; i < 5; i++) this.kotoNote(hit + 0.15 + i * 0.13, [0, 2, 3, 4, 5][i], 0.5);
    this.shakuhachi(hit + 0.8, note(7), 3.2, 0.22);
    this.shakuhachi(hit + 0.82, note(5), 3.0, 0.1);
    // Coda: the theme's last bar, slow, on the koto; one long low flute D over the home chord.
    const c = hit + 4.6;
    this.pad(c - 0.4, CHORDS[0], 9, 0.03, 480);
    [3, 2, 1].forEach((d, i) => this.kotoNote(c + i * 0.75, d, 0.38));
    this.shakuhachi(c + 2.25, note(0), 4.5, 0.15);
    this.kotoNote(c + 2.25, -5, 0.3);
  }

  private defeat(t: number): void {
    this.odaiko(t, 0.8, true);
    this.shakuhachi(t + 0.6, note(4), 1.6, 0.16);
    this.shakuhachi(t + 2.1, note(2) * 0.985, 3, 0.14);
  }

  /** The death moment: a falling bend on the flute over a deep drum (the "死" beat). */
  death(t: number): void {
    this.odaiko(t, 1, true);
    const ctx = this.mix.ctx;
    // Two detuned saw pads falling a minor third, dark.
    for (const d of [-9, 9]) {
      const o = ctx.createOscillator();
      o.type = "sawtooth";
      o.frequency.setValueAtTime(146.8, t);
      o.frequency.exponentialRampToValueAtTime(123.5, t + 2.2);
      o.detune.value = d;
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.setValueAtTime(900, t);
      lp.frequency.exponentialRampToValueAtTime(220, t + 2.6);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.09, t + 0.25);
      g.gain.exponentialRampToValueAtTime(0.0003, t + 2.8);
      o.connect(lp).connect(g).connect(this.out);
      g.connect(this.mix.musicVerb);
      o.start(t);
      o.stop(t + 2.9);
      o.onended = () => {
        o.disconnect();
        lp.disconnect();
        g.disconnect();
      };
    }
    this.shakuhachi(t + 0.3, note(6), 0.5, 0.18);
    this.shakuhachi(t + 0.8, note(4) * 0.97, 1.8, 0.16);
  }
}
