// Screenshots of the named set pieces → shinobi-duel/shots/ (for judging the look; delete after).
// Usage: node tools/shoot.mjs [scene ...]
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "./gpu.mjs";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "shots");
mkdirSync(out, { recursive: true });
const all = ["title", "fight", "thrust", "overhead", "deflect", "break", "finisher", "victory"];
const scenes = process.argv.slice(2).length ? process.argv.slice(2) : all;

const { browser, page, errors, renderer } = await launch();
console.log("renderer:", renderer);
for (const s of scenes) {
  const info = await page.evaluate((n) => window.__duel.scene(n), s);
  // CSS reveals (title / end screens) run in real time.
  await page.waitForTimeout(s === "victory" ? 2600 : s === "title" ? 4800 : 750);
  await page.screenshot({ path: join(out, `${s}${process.env.TAG ? "_" + process.env.TAG : ""}.png`) });
  console.log(s, JSON.stringify({ state: info.state, boss: info.boss, player: info.player, calls: info.drawCalls, tris: info.triangles }));
}
await browser.close();
if (errors.length) {
  console.log("ERRORS:\n" + errors.join("\n"));
  process.exit(1);
}
console.log("no console/page errors");
