// Mouse on the menus, with real mouse events on the live loop: the cursor is visible (not
// `cursor: none`) and pointer lock is off on the title, resurrection, defeat and victory screens;
// hovering a difficulty option shows a pointer; clicking each option selects it without starting
// the fight; clicking the "click to begin" prompt starts it; the controls lines fit on screen and
// clear the selector at 1280×720, 1920×1080 and 2560×1440.
// Usage: node tools/menu.mjs [--shot]   (--shot writes shots/menu-1920.png with an option hovered)
import { mkdirSync } from "node:fs";
import { launch } from "./gpu.mjs";

const { browser, page, errors } = await launch({ width: 1280, height: 720 });
let fails = 0;
const check = (ok, name, detail) => {
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  —  ${detail}`);
};
const st = () =>
  page.evaluate(() => {
    const g = window.__duel.game;
    return {
      state: g.state,
      fights: g.fightsStarted,
      chosen: g.difficulty,
      shown: document.querySelector("#title .diff .opt.on")?.dataset.difficulty ?? "",
      cursor: getComputedStyle(document.getElementById("game")).cursor,
      lock: document.pointerLockElement ? document.pointerLockElement.id || document.pointerLockElement.tagName : null,
      armed: g.input.promptArmed,
      end: document.getElementById("end").dataset.kind ?? "",
    };
  });
const waitFor = async (pred, ms = 8000) => {
  const t0 = Date.now();
  let s = await st();
  while (!pred(s) && Date.now() - t0 < ms) {
    await page.waitForTimeout(50);
    s = await st();
  }
  return s;
};
const center = async (sel) => {
  const b = await page.locator(sel).boundingBox();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};
const kill = () =>
  page.evaluate(() => {
    const g = window.__duel.game;
    g.player.health = 1;
    g.player.enter("move");
    g.bot.play = g.bot.deflect = false;
    g.place(2.2);
    g.boss.passive = false;
    g.forceBossAttack("overhead");
  });
const free = (s) => s.cursor !== "none" && s.lock === null;
const fmt = (s) => `state ${s.state}, cursor ${s.cursor}, pointerLock ${s.lock}`;

await page.evaluate(() => localStorage.removeItem("shinobi-duel.difficulty"));
await page.reload({ waitUntil: "load" });
await page.waitForFunction(() => window.__duel && window.__duel.ready, null, { timeout: 60000 });
await page.waitForTimeout(800);

// ------------------------------------------------------------------ layout at three sizes
for (const [w, h] of [
  [1280, 720],
  [1920, 1080],
  [2560, 1440],
]) {
  await page.setViewportSize({ width: w, height: h });
  await page.waitForTimeout(300);
  const L = await page.evaluate(() => {
    const r = (e) => e.getBoundingClientRect();
    const keys = document.querySelector("#title .keys");
    const diff = r(document.querySelector("#title .diff"));
    const press = r(document.querySelector("#title .press.begin"));
    // The controls table: a key column and a label column (the brush rule above them is decoration).
    const imgs = [...keys.querySelectorAll("img.kc, img.kl")].map((i) => ({ ...r(i).toJSON(), ok: i.complete && i.naturalWidth > 0 }));
    const inView = (b) => b.left >= 0 && b.top >= 0 && b.right <= innerWidth && b.bottom <= innerHeight;
    const overlap = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    const k = r(keys);
    return {
      lines: keys.querySelectorAll("img.kc").length,
      loaded: imgs.every((i) => i.ok),
      inView: imgs.every(inView) && inView(press) && inView(diff),
      clearOfDiff: !overlap(k, diff) && !overlap(k, press) && !overlap(diff, press),
      minH: Math.min(...imgs.map((i) => i.height)).toFixed(1),
      keysRight: Math.round(k.right),
      diffLeft: Math.round(diff.left),
    };
  });
  check(
    L.lines === 8 && L.loaded && L.inView && L.clearOfDiff && +L.minH >= 16,
    `${w}×${h}: controls lines on screen, readable, clear of the selector / prompt`,
    `${L.lines} lines, loaded ${L.loaded}, in view ${L.inView}, clear ${L.clearOfDiff}, line height ${L.minH}px, keys right ${L.keysRight} / selector left ${L.diffLeft}`,
  );
}
await page.setViewportSize({ width: 1920, height: 1080 });
await page.waitForTimeout(300);

// ------------------------------------------------------------------ title
let s = await st();
check(s.state === "title" && free(s), "title: cursor visible, no pointer lock", fmt(s));
const hover = await center('#title .diff .opt[data-difficulty="hard"]');
await page.mouse.move(hover.x, hover.y);
await page.waitForTimeout(350);
const hv = await page.evaluate(() => {
  const o = document.querySelector('#title .diff .opt[data-difficulty="hard"]');
  return { cursor: getComputedStyle(o).cursor, opacity: getComputedStyle(o).opacity, hovered: o.matches(":hover") };
});
check(hv.hovered && hv.cursor === "pointer" && +hv.opacity > 0.5, "hovering an option: pointer cursor + highlight", JSON.stringify(hv));
if (process.argv.includes("--shot")) {
  mkdirSync("shots", { recursive: true });
  await page.screenshot({ path: "shots/menu-1920.png" });
  console.log("wrote shots/menu-1920.png");
}
let pickOk = true;
const pickLog = [];
for (const id of ["easy", "hard", "medium", "easy"]) {
  const c = await center(`#title .diff .opt[data-difficulty="${id}"]`);
  await page.mouse.click(c.x, c.y);
  await page.waitForTimeout(200);
  s = await st();
  pickLog.push(`${id}->${s.chosen}/${s.state}/${s.lock}`);
  if (s.chosen !== id || s.shown !== id || s.state !== "title" || s.fights !== 0 || !free(s)) pickOk = false;
}
check(pickOk, "clicking each option selects it, no start, no pointer lock", pickLog.join(", "));
const bc = await page.evaluate(() => getComputedStyle(document.querySelector("#title .press.begin")).cursor);
const begin = await center("#title .press.begin");
await page.mouse.click(begin.x, begin.y);
s = await waitFor((s) => s.state === "fight");
await page.waitForTimeout(400);
s = await st();
check(s.state === "fight" && s.fights === 1 && s.chosen === "easy" && bc === "pointer", "clicking “click to begin” starts the fight", `state ${s.state}, fights ${s.fights}, chosen ${s.chosen}, prompt cursor ${bc}`);
check(s.cursor === "none", "fight: cursor hidden over the canvas", `${fmt(s)} (pointer lock is up to the browser; headless may refuse it)`);

// ------------------------------------------------------------------ resurrection, defeat, title
await kill();
s = await waitFor((s) => s.end === "death" && s.armed, 8000);
check(s.end === "death" && free(s), "resurrection screen: cursor visible, no pointer lock", fmt(s));
await page.waitForTimeout(600);
await page.mouse.click(960, 300);
s = await waitFor((s) => s.state === "fight");
check(s.state === "fight" && s.cursor === "none", "a click on the resurrection screen rises again", fmt(s));
await page.waitForTimeout(800);
await kill();
s = await waitFor((s) => s.state === "defeat" && s.armed, 8000);
check(s.state === "defeat" && free(s), "defeat screen: cursor visible, no pointer lock", fmt(s));
await page.waitForTimeout(300);
await page.keyboard.press("Escape");
s = await waitFor((s) => s.state === "title");
await page.waitForTimeout(400);
s = await st();
check(s.state === "title" && free(s) && s.fights === 1, "back on the title: cursor visible, no pointer lock", `${fmt(s)}, fights ${s.fights}`);
const c = await center('#title .diff .opt[data-difficulty="medium"]');
await page.mouse.click(c.x, c.y);
await page.waitForTimeout(200);
s = await st();
check(s.state === "title" && s.chosen === "medium" && s.fights === 1 && free(s), "after a fight, clicking an option still only selects", `${fmt(s)}, chosen ${s.chosen}, fights ${s.fights}`);

// ------------------------------------------------------------------ victory
await page.mouse.click(960, 300);
s = await waitFor((s) => s.state === "fight");
check(s.state === "fight" && s.fights === 2, "a click on the title (outside the options) starts the fight", `state ${s.state}, fights ${s.fights}`);
await page.waitForTimeout(1500);
await page.evaluate(() => {
  const g = window.__duel.game;
  g.bot.deflect = g.bot.play = false;
  g.boss.markers = 1;
  g.place(2.0);
  g.startFinisher();
});
s = await waitFor((s) => s.state === "victory", 15000);
check(s.state === "victory" && free(s), "victory screen: cursor visible, no pointer lock", fmt(s));
s = await waitFor((s) => s.armed, 8000);
await page.waitForTimeout(400);
await page.mouse.click(960, 300);
s = await waitFor((s) => s.state === "title");
await page.waitForTimeout(300);
s = await st();
check(s.state === "title" && free(s) && s.fights === 2, "a click on victory returns to the title, mouse free", `${fmt(s)}, fights ${s.fights}`);
await page.evaluate(() => localStorage.removeItem("shinobi-duel.difficulty"));

await browser.close();
if (errors.length) {
  console.log("ERRORS:\n" + errors.join("\n"));
  fails++;
}
console.log(fails ? `${fails} FAILED` : "ALL PASS");
process.exit(fails ? 1 : 0);
