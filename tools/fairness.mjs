// Fairness: simulated fights (deterministic, loop paused, 60 Hz steps) for three players.
//   perfect  — the deflect bot, exact timing: wins without dying.
//   learner  — same plan with human timing (±55 ms on every reaction, 12% of blows missed):
//              must win on the first or second attempt.
//   casual   — human-ish timing (±70 ms on every reaction, 20% of blows missed): three players,
//              each must win within three attempts.
//   masher   — mashes attack and guard (no timing, no dodges, no jumps): must lose (at most one
//              lucky win in five attempts).
//   +abilities — the same players also fire 1-2-3 (cursed blade, firecrackers, crow step) the moment
//              each is ready: the masher must still lose (abilities don't replace deflecting), the
//              learner still wins, and even frame-perfect play with abilities still takes a while.
// A death uses the resurrection when one is left; a defeat is a lost attempt (restarts fresh).
// Usage: node tools/fairness.mjs
import { launch } from "./gpu.mjs";

const { browser, page, errors } = await launch({ width: 960, height: 540 });
const result = await page.evaluate(() => {
  const g = window.__duel.game;
  const inp = g.input;
  g.pause();
  const attempt = (kind, seed, abil = false) => {
    g.startFight();
    inp.botAxis = null;
    const bot = g.bot;
    bot.healed = false;
    bot.seed = seed;
    bot.jitter = kind === "learner" ? 0.055 : kind === "casual" ? 0.07 : 0;
    bot.miss = kind === "learner" ? 0.12 : kind === "casual" ? 0.2 : 0;
    bot.play = bot.deflect = kind !== "masher";
    let s = seed;
    const R = () => ((s = (s * 48271) % 2147483647) / 2147483647);
    let next = 0;
    let up = [];
    let t = 0;
    let deaths = 0;
    while (t < 240) {
      g.step(0.25);
      t += 0.25;
      if (kind === "masher") {
        // Four sub-steps per quarter second, a press on most of them.
        for (const u of up) inp.release(u);
        up = [];
        for (let k = 0; k < 3; k++) {
          if (R() < 0.8) {
            const a = R() < 0.6 ? "attack" : "block";
            inp.press(a);
            up.push(a);
          }
          g.step(1 / 60);
        }
      }
      // Abilities: each pressed as soon as it's ready (fight only; refused presses are harmless).
      if (abil && g.state === "fight") {
        const A = g.player.abil;
        for (const [id, a] of [["curse", "ability1"], ["crackers", "ability2"], ["crow", "ability3"]]) {
          if (A.ready(id)) {
            inp.press(a);
            inp.release(a);
          }
        }
      }
      if (g.state === "dying" && inp.promptArmed) {
        deaths++;
        g.step(0.6);
        inp.promptPress("Enter");
      }
      if (g.state === "defeat") return { win: false, t: +t.toFixed(1), deaths: deaths + 1, phase: g.boss.phase, bossHp: +g.boss.health.toFixed(0) };
      if (g.state === "victory") return { win: true, t: +t.toFixed(1), deaths, phase: 2, bossHp: 0 };
    }
    return { win: false, t, deaths, timeout: true, phase: g.boss.phase };
  };
  const used = () => ({ ...g.player.abil.used });
  const out = {};
  for (const kind of ["perfect", "learner"]) {
    out[kind] = [];
    for (let i = 0; i < 3; i++) out[kind].push(attempt(kind, 11 + i * 7919));
  }
  out.masher = [];
  for (let i = 0; i < 5; i++) out.masher.push(attempt("masher", 11 + i * 7919));
  // Casual players: up to three attempts each, stop at the first win.
  out.casual = [];
  for (let pl = 0; pl < 3; pl++) {
    const tries = [];
    for (let k = 0; k < 3; k++) {
      const r = attempt("casual", 101 + pl * 104729 + k * 7919);
      tries.push(r);
      if (r.win) break;
    }
    out.casual.push(tries);
  }
  // The same players with abilities on every recharge.
  out.perfectAb = [];
  for (let i = 0; i < 3; i++) {
    const r = attempt("perfect", 11 + i * 7919, true);
    r.used = used();
    out.perfectAb.push(r);
  }
  out.learnerAb = [];
  for (let i = 0; i < 3; i++) out.learnerAb.push(attempt("learner", 11 + i * 7919, true));
  out.masherAb = [];
  for (let i = 0; i < 5; i++) {
    const r = attempt("masher", 11 + i * 7919, true);
    r.used = used();
    out.masherAb.push(r);
  }
  g.bot.play = g.bot.deflect = false;
  g.bot.jitter = g.bot.miss = 0;
  g.resume();
  return out;
});
await browser.close();
let fails = 0;
const report = (ok, name, detail) => {
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  —  ${detail}`);
};
const fmt = (r) => r.map((x) => `${x.win ? "WIN" : "LOSS"} ${x.t}s deaths ${x.deaths} (phase ${x.phase}${x.win ? "" : `, boss ${x.bossHp} hp`})`).join(" | ");
report(result.perfect.every((r) => r.win && r.deaths === 0), "fair: exact deflects win without dying", fmt(result.perfect));
// A learner's run of attempts: the first win must come on attempt 1 or 2 (three independent runs).
const first = result.learner.findIndex((r) => r.win);
report(first === 0 || first === 1, "fair: a player who learns deflects (±55 ms, 12% misses) wins on the 1st or 2nd try", fmt(result.learner));
report(result.casual.every((tries) => tries.some((r) => r.win)), "fair: a casual player (±70 ms, 20% misses) wins within 3 tries", result.casual.map((tries, i) => `player ${i + 1}: ${tries.findIndex((r) => r.win) + 1 || "no win"} [${fmt(tries)}]`).join(" || "));
report(result.masher.filter((r) => r.win).length <= 1, "fair: mashing attack + guard (mostly) loses", fmt(result.masher));
report(result.perfect.every((r) => r.t > 25), "fair: the duel lasts (frame-perfect play > 25 s)", result.perfect.map((r) => `${r.t}s`).join(", "));
// Abilities.
const ab = (r) => (r.used ? ` [1:${r.used.curse} 2:${r.used.crackers} 3:${r.used.crow}]` : "");
const fmtA = (rs) => rs.map((x) => fmt([x]) + ab(x)).join(" | ");
report(result.perfectAb.every((r) => r.win && r.used.curse + r.used.crackers + r.used.crow >= 3), "abilities: exact deflects + every ability on recharge still win (abilities fire)", fmtA(result.perfectAb));
report(result.perfectAb.every((r) => r.t > 20), "abilities: they don't trivialise it (frame-perfect + abilities > 20 s)", result.perfectAb.map((r, i) => `${r.t}s (without: ${result.perfect[i].t}s)`).join(", "));
const firstAb = result.learnerAb.findIndex((r) => r.win);
report(firstAb === 0 || firstAb === 1, "abilities: the learner with abilities wins on the 1st or 2nd try", fmt(result.learnerAb));
report(result.masherAb.filter((r) => r.win).length <= 1, "abilities: mashing + every ability on recharge (no deflects) still loses", fmtA(result.masherAb));
if (errors.length) {
  console.log("ERRORS:\n" + errors.join("\n"));
  fails++;
}
console.log(fails ? `${fails} FAILED` : "ALL PASS");
process.exit(fails ? 1 : 0);
