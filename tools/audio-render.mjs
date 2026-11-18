// Offline audio check: renders key sounds through the real mix (buses, reverb, limiter) with an
// OfflineAudioContext in headless Chromium and prints peak / RMS / crest / spectral centroid,
// flagging clipping, silence and NaN. No GPU needed. Needs the dev server (DUEL_URL, default 5411).
//   node tools/audio-render.mjs [name ...]      (default: all)
//   node tools/audio-render.mjs --wav clang     also writes tmp WAVs to tools/.audio-tmp/ (delete after)
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const URL = process.env.DUEL_URL ?? "http://localhost:5411/";
const args = process.argv.slice(2);
const wav = args.includes("--wav");
const only = args.filter((a) => !a.startsWith("--"));

// name → [seconds, js body run with `a` = GameAudio attached to the offline context]
const SOUNDS = {
  clang: [3, "at(0.1, () => a.clang(1))"],
  clangChain: [4, "for (let i = 0; i < 5; i++) at(0.1 + i * 0.45, () => a.clang(1))"],
  clangSoft: [2, "a.clang(0.5)"],
  blockThud: [1.5, "a.blockThud()"],
  guardBreak: [2, "a.guardBreak()"],
  postureBreak: [3, "a.drum(true)"],
  whoosh: [1, "a.whoosh(false)"],
  whooshHeavy: [1, "a.whoosh(true)"],
  bossWhoosh: [1.5, "a.whoosh(false, 'boss')"],
  bossWhooshHeavy: [1.5, "a.whoosh(true, 'boss')"],
  hitArmour: [1, "a.hitFlesh(true)"],
  hitCloth: [1, "a.hitFlesh(false)"],
  hurt: [1.2, "a.hurt()"],
  mikiri: [2, "a.mikiri()"],
  kickHead: [1.5, "a.kick(true)"],
  grab: [1.5, "a.grab()"],
  throwSlam: [1.5, "a.throwSlam()"],
  slam: [1.5, "a.slam()"],
  footstep: [0.5, "a.footstep(3)"],
  bossStep: [0.6, "a.bossStep()"],
  dodge: [1, "a.dodge()"],
  dodgeFwd: [1, "a.dodge('forward')"],
  dodgeBack: [1, "a.dodge('back')"],
  dodgeSide: [1, "a.dodge('left')"],
  nearMiss: [1.5, "a.nearMiss()"],
  hitAccent: [0.8, "a.hitAccent()"],
  postureWarn: [1.2, "a.postureWarn()"],
  gourdTick: [0.4, "a.gourdTick()"],
  jump: [0.6, "a.jump()"],
  land: [0.6, "a.land()"],
  drinkSip: [2, "a.drink(); at(0.4, () => a.sip())"],
  revive: [3.5, "a.revive()"],
  deathblow: [3.5, "a.deathblow()"],
  finisher: [4.5, "a.finisher()"],
  pluck: [3.5, "a.pluck()"],
  glint: [1, "a.glint()"],
  peril: [1.5, "a.peril()"],
  bossRise: [3, "a.bossRise()"],
  deathSting: [4, "a.deathSting()"],
  charged: [1.5, "a.scene('', null, null, null, 1, true); at(0.7, () => a.scene('', null, null, null, 1, false)); at(0.7, () => a.whoosh(true))"],
  voiceAttack: [0.8, "at(0.1, () => a.voice.playerAttack(0.1, true))"],
  voiceHurt: [0.8, "at(0.1, () => a.voice.playerHurt(0.1, true))"],
  voiceKiai: [1, "at(0.1, () => a.voice.bossKiai(0.1, true))"],
  battleCry: [2.5, "at(0.1, () => a.voice.bossBattleCry(0.1))"],
  ambience: [12, "a.attachAmb = 1"],
  musicTitle: [20, "a.debugScene('title')"],
  musicFight: [10, "a.debugScene('fight'); a.intensity = 0.55; a.taikoTempo = 84"],
  musicFightHot: [10, "a.debugScene('fight'); a.intensity = 1.1; a.taikoTempo = 130"],
  musicPhase2: [12, "a.debugScene('fight'); a.intensity = 1.1; a.taikoTempo = 144; a.music.phase = 2"],
  victory: [14, "a.debugScene('fight'); at(0.2, () => a.debugScene('victory'))"],
  defeat: [5, "a.debugScene('defeat')"],
  // Worst case: a deflect chain over a hot fight with a posture break on top.
  stress: [4, "a.debugScene('fight'); a.intensity = 1.1; a.taikoTempo = 130; for (let i = 0; i < 4; i++) at(0.2 + i * 0.3, () => a.clang(1)); at(1.4, () => a.drum(true)); at(1.45, () => a.hitFlesh(true)); at(1.5, () => a.whoosh(true, 'boss'))"],
};

const names = only.length ? only : Object.keys(SOUNDS);
const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
// Any same-origin page works; the module is imported dynamically (Vite transforms the TS).
await page.goto(new globalThis.URL("/src/audio/Audio.ts", URL).href);

let bad = 0;
console.log("name".padEnd(17), "peak dB  rms dB  crest  centroid Hz  >0.98  nan   tail");
for (const name of names) {
  const [secs, body] = SOUNDS[name];
  const r = await page.evaluate(
    async ({ secs, body, amb, wantWav }) => {
      const { GameAudio } = await import("/src/audio/Audio.ts");
      const sr = 48000;
      const ctx = new OfflineAudioContext(2, Math.ceil(sr * secs), sr);
      const a = new GameAudio();
      a.attach(ctx, { ambience: amb });
      a.scene("", null, null, null, 1, false);
      // Drive update() every 50 ms of audio time (music / ambience schedulers), and timed calls.
      const timed = [];
      const at = (t, fn) => timed.push([t, fn]);
      new Function("a", "at", body)(a, at);
      for (let t = 0.05; t < secs; t += 0.05) {
        ctx.suspend(t).then(() => {
          for (const [tt, fn] of timed) if (tt <= t && tt > t - 0.05) fn();
          a.update(0.05);
          ctx.resume();
        });
      }
      a.update(0.016);
      const buf = await ctx.startRendering();
      const L = buf.getChannelData(0), R = buf.getChannelData(1);
      let peak = 0, sum = 0, nan = 0, over = 0;
      for (let i = 0; i < L.length; i++) {
        for (const v of [L[i], R[i]]) {
          if (!Number.isFinite(v)) { nan++; continue; }
          const av = Math.abs(v);
          if (av > peak) peak = av;
          if (av > 0.98) over++;
          sum += v * v;
        }
      }
      const rms = Math.sqrt(sum / (L.length * 2));
      // Spectral centroid over the loudest 4096-sample window (radix-2 FFT, Hann).
      const N = 4096;
      let best = 0, bestE = -1;
      for (let s = 0; s + N < L.length; s += N / 2) {
        let e = 0;
        for (let i = 0; i < N; i += 8) e += L[s + i] * L[s + i];
        if (e > bestE) { bestE = e; best = s; }
      }
      const re = new Float64Array(N), im = new Float64Array(N);
      for (let i = 0; i < N; i++) re[i] = ((L[best + i] ?? 0) + (R[best + i] ?? 0)) * 0.5 * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
      for (let i = 1, j = 0; i < N; i++) {
        let bit = N >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
      }
      for (let len = 2; len <= N; len <<= 1) {
        const ang = (-2 * Math.PI) / len;
        for (let i = 0; i < N; i += len) {
          for (let k = 0; k < len / 2; k++) {
            const wr = Math.cos(ang * k), wi = Math.sin(ang * k);
            const ar = re[i + k + len / 2], ai = im[i + k + len / 2];
            const xr = ar * wr - ai * wi, xi = ar * wi + ai * wr;
            re[i + k + len / 2] = re[i + k] - xr; im[i + k + len / 2] = im[i + k] - xi;
            re[i + k] += xr; im[i + k] += xi;
          }
        }
      }
      let num = 0, den = 0;
      for (let k = 1; k < N / 2; k++) {
        const mag = Math.hypot(re[k], im[k]);
        num += mag * (k * sr) / N;
        den += mag;
      }
      // Tail: RMS of the last 10% vs overall (a long ring-out / reverb keeps energy).
      let tail = 0;
      const t0 = Math.floor(L.length * 0.9);
      for (let i = t0; i < L.length; i++) tail += L[i] * L[i];
      tail = Math.sqrt(tail / (L.length - t0));
      let wavB64 = null;
      if (wantWav) {
        const n = L.length, bytes = new DataView(new ArrayBuffer(44 + n * 4));
        const w = (o, s) => [...s].forEach((c, i) => bytes.setUint8(o + i, c.charCodeAt(0)));
        w(0, "RIFF"); bytes.setUint32(4, 36 + n * 4, true); w(8, "WAVEfmt ");
        bytes.setUint32(16, 16, true); bytes.setUint16(20, 1, true); bytes.setUint16(22, 2, true);
        bytes.setUint32(24, sr, true); bytes.setUint32(28, sr * 4, true); bytes.setUint16(32, 4, true);
        bytes.setUint16(34, 16, true); w(36, "data"); bytes.setUint32(40, n * 4, true);
        for (let i = 0; i < n; i++) {
          bytes.setInt16(44 + i * 4, Math.max(-1, Math.min(1, L[i])) * 32767, true);
          bytes.setInt16(46 + i * 4, Math.max(-1, Math.min(1, R[i])) * 32767, true);
        }
        let s = "";
        const u8 = new Uint8Array(bytes.buffer);
        for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
        wavB64 = btoa(s);
      }
      return { peak, rms, nan, over, centroid: den ? num / den : 0, tail, wavB64 };
    },
    { secs, body, amb: name === "ambience", wantWav: wav },
  );
  const db = (v) => (v > 0 ? (20 * Math.log10(v)).toFixed(1) : "-inf");
  const flags = [];
  if (r.nan) flags.push("NaN");
  if (r.over) flags.push("CLIP");
  if (r.peak < 0.01) flags.push("SILENT");
  if (flags.length) bad++;
  console.log(
    name.padEnd(17),
    db(r.peak).padStart(7),
    db(r.rms).padStart(7),
    (r.peak / (r.rms || 1)).toFixed(1).padStart(6),
    r.centroid.toFixed(0).padStart(12),
    String(r.over).padStart(6),
    String(r.nan).padStart(4),
    db(r.tail).padStart(7),
    flags.join(" "),
  );
  if (r.wavB64) {
    mkdirSync("tools/.audio-tmp", { recursive: true });
    writeFileSync(`tools/.audio-tmp/${name}.wav`, Buffer.from(r.wavB64, "base64"));
  }
}
await browser.close();
if (errors.length) console.log("errors:", errors);
console.log(bad || errors.length ? `FAIL (${bad} flagged, ${errors.length} errors)` : "PASS");
process.exit(bad || errors.length ? 1 : 0);
