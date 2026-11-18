/**
 * DOM overlay. During the fight only a few things are on screen: the general's name with his
 * deathblow markers, posture bar over health bar (bottom centre), and the player's health +
 * posture with the gourd count and the resurrection node (bottom-left, minimal). Title, death
 * and end screens use generated brush lettering.
 */
import { rng } from "../core/math";
import type { DifficultyName } from "../game/difficulty";
import { brushStroke, brushText, KANJI_FONT, LATIN_FONT } from "./brush";

const CSS = /* css */ `
#hud { position: fixed; inset: 0; pointer-events: none; font-family: ${LATIN_FONT}; color: #efe7da; user-select: none; }
#hud .layer { position: absolute; inset: 0; transition: opacity 0.6s ease; }
#hud .hidden { opacity: 0; }
#hud canvas.brush { display: block; }
/* title */
#hud #title.hidden { transition-duration: 0.12s; }
#title { display: block; }
/* Poster layout: the two kanji stacked in a brushed column on the right, a red stroke down their
   spine, the latin name small beneath; the moon, the keep and the duellists own the rest. */
#title .t-block { position: absolute; right: 12vw; top: 6vh; display: flex; flex-direction: column; align-items: center; }
#title .t-col { position: relative; display: flex; flex-direction: column; align-items: center; }
#title .t-kanji { height: min(25vh, 250px); width: auto; filter: drop-shadow(0 0 24px rgba(0,0,0,0.7)); margin: -2.6vh 0; position: relative; z-index: 1; }
#title .t-stroke { position: absolute; left: 50%; top: 50%; width: min(46vh, 460px); height: min(5vh, 50px); transform: translate(-50%, -50%) rotate(90deg); opacity: 0.88; }
#title .t-latin { width: min(17vw, 250px); height: auto; margin-top: 1.8vh; opacity: 0.88; }
#title .t-seal { position: absolute; right: -4.4vh; bottom: 3vh; width: 4vh; height: auto; z-index: 2; }
#title .press { position: absolute; right: 7vw; bottom: 9vh; height: 30px; width: auto; opacity: 0.8; animation: breathe 3.6s ease-in-out infinite; }
#title .keys { position: absolute; left: 4vw; bottom: 7vh; display: flex; flex-direction: column; align-items: flex-start; gap: 2px; opacity: 0.72; width: max-content; }
#title .keys img { height: min(2.6vh, 22px); width: auto; flex: none; filter: drop-shadow(0 1px 3px rgba(0,0,0,0.9)); }
/* the begin prompt is clickable; its mousedown bubbles to Input as a title "any key" press */
#title:not(.hidden) .press.begin { pointer-events: auto; cursor: pointer; }
#title .press.begin:hover { animation: none; opacity: 1; filter: drop-shadow(0 0 6px rgba(255,140,60,0.45)); }
@keyframes breathe { 0%,100% { opacity: 0.35 } 50% { opacity: 0.85 } }
/* difficulty: three brushed choices, the chosen one underlined in crimson ink */
#title .diff { position: absolute; left: 50%; bottom: 8.5vh; transform: translateX(-50%); display: flex; align-items: flex-end; gap: min(3.2vw, 44px); }
#title .diff .opt { position: relative; display: flex; align-items: center; gap: 6px; padding: 4px 6px 12px; opacity: 0.5; cursor: pointer; transition: opacity 0.25s ease; filter: drop-shadow(0 1px 4px rgba(0,0,0,0.85)); }
#title:not(.hidden) .diff .opt { pointer-events: auto; }
#title .diff .opt:hover { opacity: 0.8; }
#title .diff .opt:not(.on):hover .u { opacity: 0.35; transform: scaleX(0.7); }
#title .diff .opt.on { opacity: 0.95; }
#title .diff .opt .k { height: min(4vh, 34px); width: auto; }
#title .diff .opt .l { height: min(2.3vh, 19px); width: auto; }
#title .diff .opt .u { position: absolute; left: -4%; bottom: 0; width: 108%; height: 10px; opacity: 0; transform: scaleX(0.4); transform-origin: left center; transition: opacity 0.2s ease, transform 0.3s cubic-bezier(.5,.05,.3,1); }
#title .diff .opt.on .u { opacity: 0.9; transform: scaleX(1); }
#playerbar .diffmark { height: 17px; width: auto; opacity: 0.45; margin-left: 2px; }
/* boss */
#bossbar { position: absolute; left: 50%; bottom: 5.2vh; transform: translateX(-50%); width: min(44vw, 640px); display: flex; flex-direction: column; align-items: center; }
#bossbar .name { height: 58px; width: auto; margin-bottom: 2px; filter: drop-shadow(0 2px 6px rgba(0,0,0,0.9)); }
#bossbar .markers { display: flex; gap: 6px; align-items: center; margin-right: 6px; }
#bossbar .markers img { width: 22px; height: 22px; transition: opacity 0.5s, transform 0.5s, filter 0.5s; filter: drop-shadow(0 0 4px rgba(0,0,0,0.9)); }
#bossbar .markers img.gone { opacity: 0.18; transform: scale(0.7) rotate(25deg); filter: grayscale(1); }
#bossbar.p2 .name { filter: drop-shadow(0 0 8px rgba(255,90,30,0.55)) drop-shadow(0 2px 6px rgba(0,0,0,0.9)); }
/* Posture: an ink stroke that spreads from the centre; colour runs bone -> ember as it fills. */
.posture { position: relative; width: 100%; height: 14px; margin-bottom: 4px; transition: opacity 0.4s; }
.posture .wash, .posture .fill { position: absolute; top: 0; bottom: 0; -webkit-mask-size: 100% 100%; mask-size: 100% 100%; -webkit-mask-image: var(--stroke); mask-image: var(--stroke); }
.posture .wash { left: 0; right: 0; background: rgba(12,9,8,0.55); }
.posture .fill { left: 50%; width: 0%; transform: translateX(-50%); background: #d9cdb4; }
.posture.broken .fill { background: #e8401c; animation: pulse 0.35s ease-in-out infinite alternate; }
.posture.near .fill { animation: pulse 0.22s ease-in-out infinite alternate; }
.posture.limited .wash { background: rgba(90,10,6,0.6); animation: limited 0.9s ease-in-out infinite alternate; }
.posture .tick { position: absolute; left: 50%; top: 2px; bottom: 2px; width: 1px; transform: translateX(-50%); background: rgba(240,228,205,0.5); }
@keyframes pulse { from { filter: brightness(1) } to { filter: brightness(1.6) } }
@keyframes limited { from { opacity: 0.55 } to { opacity: 1 } }
.health { position: relative; width: 100%; height: 6px; -webkit-mask-size: 100% 100%; mask-size: 100% 100%; -webkit-mask-image: var(--line); mask-image: var(--line); background: rgba(8,6,6,0.6); }
.health .lag { position: absolute; left: 0; top: 0; bottom: 0; width: 100%; background: rgba(230,215,195,0.55); }
.health .fill { position: absolute; left: 0; top: 0; bottom: 0; width: 100%; background: #9c2016; }
.health.heal .fill { background: #b83a24; }
/* player */
#playerbar { position: absolute; left: 3.2vw; bottom: 5.2vh; width: min(20vw, 280px); }
#playerbar .posture { height: 6px; margin-bottom: 6px; }
#playerbar .health { height: 5px; }
#playerbar .crest { width: 22px; height: 22px; position: absolute; left: -30px; bottom: -6px; opacity: 0.8; }
#playerbar .row { position: absolute; left: 0; bottom: 22px; display: flex; align-items: flex-end; gap: 10px; }
#playerbar .rez { width: 16px; height: 16px; transition: opacity 0.4s, filter 0.4s; }
#playerbar .rez.spent { opacity: 0.25; filter: grayscale(1); }
#playerbar .gourd { display: flex; align-items: flex-end; gap: 3px; }
#playerbar .gourd img { width: 15px; height: 22px; }
#playerbar .gourd span { font-size: 15px; line-height: 15px; color: #e9dfcf; text-shadow: 0 1px 3px #000; letter-spacing: 0.05em; }
#playerbar .gourd.empty { opacity: 0.35; }
/* end screens: the scene dims behind, the brush word paints on in ~0.4 s */
#end { display: flex; flex-direction: column; align-items: center; justify-content: flex-start; padding-top: 16vh; }
#end .e-kanji { width: min(40vw, 560px); height: auto; clip-path: inset(0 100% 0 0); opacity: 0; filter: drop-shadow(0 0 24px rgba(0,0,0,0.6)); }
#end.show .e-kanji { animation: reveal 0.45s cubic-bezier(.5,.05,.3,1) forwards; }
#end .e-latin { margin-top: 0.4vh; height: 34px; width: auto; opacity: 0; }
#end.show .e-latin { animation: fadein 0.4s ease 0.3s forwards; }
#end .press { position: absolute; left: 50%; transform: translateX(-50%); bottom: 12vh; height: 26px; width: auto; opacity: 0; }
#end.prompt .press { animation: breathe 3.6s ease-in-out infinite; }
@keyframes reveal { 0% { opacity: 0; clip-path: inset(0 100% 0 0); } 20% { opacity: 1; } 100% { opacity: 1; clip-path: inset(0 0% 0 0); } }
@keyframes fadein { to { opacity: 0.9; } }
`;

function el(tag: string, cls?: string, parent?: HTMLElement): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  parent?.appendChild(e);
  return e;
}

function bar(parent: HTMLElement): { root: HTMLElement; fill: HTMLElement; lag?: HTMLElement } {
  const root = el("div", "", parent);
  el("div", "wash", root);
  const fill = el("div", "fill", root);
  return { root, fill };
}

/** Posture colour: bone at rest, warming through ochre to ember near the break. */
function ramp(k: number): string {
  const stops = [
    [0, 217, 205, 180],
    [0.55, 214, 150, 62],
    [0.85, 232, 96, 30],
    [1, 240, 64, 22],
  ];
  let i = 1;
  while (i < stops.length - 1 && k > stops[i][0]) i++;
  const [a, b] = [stops[i - 1], stops[i]];
  const t = Math.min(1, Math.max(0, (k - a[0]) / (b[0] - a[0])));
  const c = (j: number) => Math.round(a[j] + (b[j] - a[j]) * t);
  return `rgb(${c(1)},${c(2)},${c(3)})`;
}

/** A round ink dab with a ragged rim (deathblow marker / resurrection node). */
function inkDab(size: number, color: string, seed: number, hollow = false): string {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d")!;
  const R = rng(seed);
  const cx = size / 2;
  const r = size * 0.36;
  g.fillStyle = color;
  g.strokeStyle = color;
  g.beginPath();
  for (let i = 0; i <= 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    const rr = r * (0.9 + R() * 0.16);
    const x = cx + Math.cos(a) * rr;
    const y = cx + Math.sin(a) * rr;
    if (i) g.lineTo(x, y);
    else g.moveTo(x, y);
  }
  g.closePath();
  if (hollow) {
    g.lineWidth = size * 0.1;
    g.stroke();
  } else g.fill();
  // Dry-brush flecks.
  for (let i = 0; i < 6; i++) {
    const a = R() * Math.PI * 2;
    const d = r * (1.05 + R() * 0.25);
    g.beginPath();
    g.arc(cx + Math.cos(a) * d, cx + Math.sin(a) * d, size * (0.015 + R() * 0.03), 0, Math.PI * 2);
    g.fill();
  }
  return c.toDataURL();
}

/** The gourd: two lobes and a stopper, in bone ink. */
function gourdIcon(): string {
  const c = document.createElement("canvas");
  c.width = 30;
  c.height = 44;
  const g = c.getContext("2d")!;
  g.fillStyle = "#e6dac6";
  g.beginPath();
  g.ellipse(15, 31, 11, 11, 0, 0, Math.PI * 2);
  g.fill();
  g.beginPath();
  g.ellipse(15, 15, 7, 7.5, 0, 0, Math.PI * 2);
  g.fill();
  g.fillRect(12.5, 4, 5, 6);
  g.fillStyle = "#8a1a12";
  g.fillRect(9, 21, 12, 3);
  return c.toDataURL();
}

export const BOSS_NAME = { kanji: "鬼影 正虎", latin: "Onikage Masatora" };

type EndKind = "victory" | "defeat" | "death";
const PROMPTS: Record<EndKind, string> = {
  death: "E / Enter / click  ·  rise again          Esc  ·  accept death",
  defeat: "Enter / click  ·  duel again          Esc  ·  title",
  victory: "Enter / click  ·  title",
};
const CONTROLS = [
  "LMB / J  strike   ·   hold  charged cut",
  "RMB / K  guard   ·   tap as it lands  deflect",
  "MMB / Q  lock on        mouse  look        WASD  move",
  "Shift  step   ·   hold  run   ·   into a thrust  mikiri",
  "Space  jump   ·   again at him  kick        R  gourd",
  "A / D  ·  1 2 3  ·  click  difficulty",
];
const DIFFS: { id: DifficultyName; kanji: string; latin: string }[] = [
  { id: "easy", kanji: "易", latin: "Easy" },
  { id: "medium", kanji: "中", latin: "Medium" },
  { id: "hard", kanji: "難", latin: "Hard" },
];

export class Hud {
  private readonly title: HTMLElement;
  private readonly fight: HTMLElement;
  private readonly end: HTMLElement;
  private readonly bossbar: HTMLElement;
  private readonly bPost: HTMLElement;
  private readonly bPostFill: HTMLElement;
  private readonly bHp: HTMLElement;
  private readonly bLag: HTMLElement;
  private readonly pPost: HTMLElement;
  private readonly pPostFill: HTMLElement;
  private readonly pHpBar: HTMLElement;
  private readonly pHp: HTMLElement;
  private readonly pLag: HTMLElement;
  private readonly markerEls: HTMLImageElement[] = [];
  private readonly rezEl: HTMLImageElement;
  private readonly gourdEl: HTMLElement;
  private readonly gourdN: HTMLElement;
  private readonly eKanji: HTMLImageElement;
  private readonly eLatin: HTMLImageElement;
  private readonly ePress: HTMLImageElement;
  private bLagV = 1;
  private pLagV = 1;
  private bLagHold = 0;
  private pLagHold = 0;
  private lastB = 1;
  private lastP = 1;
  private shownMarkers = -1;
  private shownGourd = -1;
  private shownRez = -1;
  private readonly kanjiCache = new Map<string, string>();
  private readonly latinCache = new Map<string, string>();
  private readonly diffEls = new Map<DifficultyName, HTMLElement>();
  private readonly diffMarks = new Map<DifficultyName, string>();
  private readonly diffMark: HTMLImageElement;
  /** A difficulty clicked on the title. */
  onDifficultyPick: ((d: DifficultyName) => void) | null = null;

  constructor(root: HTMLElement) {
    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.appendChild(style);

    // ---------------------------------------------------------------- title
    this.title = el("div", "layer", root);
    this.title.id = "title";
    const block = el("div", "t-block", this.title);
    const col = el("div", "t-col", block);
    const st = brushStroke(900, 60, "#8a1a12", 5);
    const stImg = new Image();
    stImg.src = st.toDataURL();
    stImg.className = "t-stroke";
    col.appendChild(stImg);
    ["雪", "刃"].forEach((ch, i) => {
      const k = brushText(ch, { size: 260, color: "#f1ebe0", seed: 21 + i * 5, dry: 0.7, splatter: 0.6, glow: "rgba(150,180,255,0.18)" });
      const img = new Image();
      img.src = k.toDataURL();
      img.className = "t-kanji";
      col.appendChild(img);
    });
    // A small red seal stamp (落款) beside the first character.
    const seal = brushText("影", { size: 90, color: "#b3241a", seed: 77, dry: 0.4, splatter: 0, pad: 6 });
    const sealImg = new Image();
    sealImg.src = seal.toDataURL();
    sealImg.className = "t-seal";
    col.appendChild(sealImg);
    const tl = brushText("SHINOBI DUEL", { size: 64, font: LATIN_FONT, weight: 700, color: "#efe7da", seed: 4, dry: 0.35, splatter: 0.1, letterSpacing: 0.28 });
    const tlImg = new Image();
    tlImg.src = tl.toDataURL();
    tlImg.className = "t-latin";
    block.appendChild(tlImg);
    const titlePress = this.pressImg();
    titlePress.src = this.smallURL("press any key  ·  click to begin");
    titlePress.classList.add("begin");
    this.title.appendChild(titlePress);
    const keys = el("div", "keys", this.title);
    CONTROLS.forEach((line, i) => {
      const img = new Image();
      img.src = brushText(line, { size: 26, font: LATIN_FONT, weight: 400, color: "#e8dfd0", seed: 40 + i, dry: 0.25, splatter: 0, letterSpacing: 0.08, pad: 4 }).toDataURL();
      keys.appendChild(img);
    });
    const diff = el("div", "diff", this.title);
    DIFFS.forEach((d, i) => {
      const opt = el("div", "opt", diff);
      opt.dataset.difficulty = d.id;
      const k = new Image();
      k.className = "k";
      k.src = brushText(d.kanji, { size: 64, color: "#f1ebe0", seed: 50 + i, dry: 0.6, splatter: 0.15, pad: 6 }).toDataURL();
      const l = new Image();
      l.className = "l";
      l.src = brushText(d.latin, { size: 28, font: LATIN_FONT, weight: 600, color: "#ece3d4", seed: 55 + i, dry: 0.3, splatter: 0, letterSpacing: 0.14, pad: 4 }).toDataURL();
      const u = new Image();
      u.className = "u";
      u.src = brushStroke(240, 18, "#a8231a", 60 + i).toDataURL();
      opt.append(k, l, u);
      // Swallow the press so the title's "any key" prompt never sees it.
      opt.addEventListener("mousedown", (e) => {
        e.stopPropagation();
        e.preventDefault();
        if (e.button === 0) this.onDifficultyPick?.(d.id);
      });
      this.diffEls.set(d.id, opt);
      this.diffMarks.set(d.id, k.src);
    });

    // ---------------------------------------------------------------- fight HUD
    this.fight = el("div", "layer hidden", root);
    const bb = el("div", "", this.fight);
    bb.id = "bossbar";
    this.bossbar = bb;
    const nameC = brushText(BOSS_NAME.kanji, { size: 70, color: "#f3ece0", seed: 8, dry: 0.55, splatter: 0.25, letterSpacing: 0.05 });
    const latinC = brushText(BOSS_NAME.latin, { size: 34, font: LATIN_FONT, weight: 600, color: "#e9e0d2", seed: 12, dry: 0.25, splatter: 0, letterSpacing: 0.12 });
    const nameWrap = el("div", "", bb);
    nameWrap.style.cssText = "display:flex;align-items:center;gap:10px;margin-bottom:2px";
    // Deathblow markers: crimson seals, one per life left.
    const marks = el("div", "markers", nameWrap);
    for (let i = 0; i < 2; i++) {
      const m = new Image();
      m.src = inkDab(44, "#b0180e", 70 + i);
      marks.appendChild(m);
      this.markerEls.push(m);
    }
    const nImg = new Image();
    nImg.src = nameC.toDataURL();
    nImg.className = "name";
    nameWrap.appendChild(nImg);
    const lImg = new Image();
    lImg.src = latinC.toDataURL();
    lImg.style.cssText = "height:34px;width:auto;opacity:0.85;filter:drop-shadow(0 2px 5px rgba(0,0,0,0.9))";
    nameWrap.appendChild(lImg);
    const bp = bar(bb);
    bp.root.className = "posture";
    el("div", "tick", bp.root);
    this.bPost = bp.root;
    this.bPostFill = bp.fill;
    const bh = el("div", "health", bb);
    this.bLag = el("div", "lag", bh);
    this.bHp = el("div", "fill", bh);

    const pb = el("div", "", this.fight);
    pb.id = "playerbar";
    const row = el("div", "row", pb);
    this.rezEl = new Image();
    this.rezEl.className = "rez";
    this.rezEl.src = inkDab(32, "#9fd0d8", 91);
    row.appendChild(this.rezEl);
    this.gourdEl = el("div", "gourd", row);
    const gi = new Image();
    gi.src = gourdIcon();
    this.gourdEl.appendChild(gi);
    this.gourdN = el("span", "", this.gourdEl);
    this.diffMark = new Image();
    this.diffMark.className = "diffmark";
    row.appendChild(this.diffMark);
    const pp = bar(pb);
    pp.root.className = "posture";
    el("div", "tick", pp.root);
    this.pPost = pp.root;
    this.pPostFill = pp.fill;
    const ph = el("div", "health", pb);
    this.pHpBar = ph;
    this.pLag = el("div", "lag", ph);
    this.pHp = el("div", "fill", ph);
    const crest = brushText("忍", { size: 60, color: "#e8dccb", seed: 3, dry: 0.4, splatter: 0, pad: 4 });
    const cImg = new Image();
    cImg.src = crest.toDataURL();
    cImg.className = "crest";
    pb.appendChild(cImg);

    // ---------------------------------------------------------------- end screens
    this.end = el("div", "layer hidden", root);
    this.end.id = "end";
    this.eKanji = new Image();
    this.eKanji.className = "e-kanji";
    this.end.appendChild(this.eKanji);
    this.eLatin = new Image();
    this.eLatin.className = "e-latin";
    this.end.appendChild(this.eLatin);
    this.ePress = this.pressImg();
    this.end.appendChild(this.ePress);
    // Brush masks for the bars.
    const stroke = brushStroke(600, 40, "#ffffff", 9);
    const sym = document.createElement("canvas");
    sym.width = 1200;
    sym.height = 40;
    const sg = sym.getContext("2d")!;
    sg.drawImage(stroke, 600, 0);
    sg.save();
    sg.scale(-1, 1);
    sg.drawImage(stroke, -600, 0);
    sg.restore();
    root.style.setProperty("--stroke", `url(${sym.toDataURL()})`);
    root.style.setProperty("--line", `url(${brushStroke(800, 24, "#ffffff", 14).toDataURL()})`);
  }

  private pressImg(): HTMLImageElement {
    const img = new Image();
    img.className = "press";
    return img;
  }

  private smallURL(text: string): string {
    let u = this.latinCache.get("s:" + text);
    if (!u) {
      u = brushText(text, { size: 30, font: LATIN_FONT, weight: 400, color: "#ece3d4", seed: 6, dry: 0.3, splatter: 0, letterSpacing: 0.18 }).toDataURL();
      this.latinCache.set("s:" + text, u);
    }
    return u;
  }

  private latinURL(text: string): string {
    let u = this.latinCache.get(text);
    if (!u) {
      u = brushText(text, { size: 40, font: LATIN_FONT, weight: 600, color: "#ece3d4", seed: 5, dry: 0.3, splatter: 0, letterSpacing: 0.6 }).toDataURL();
      this.latinCache.set(text, u);
    }
    return u;
  }

  showTitle(on: boolean): void {
    this.title.classList.toggle("hidden", !on);
  }

  showFight(on: boolean): void {
    this.fight.classList.toggle("hidden", !on);
  }

  /** The title's highlighted choice. */
  setDifficulty(d: DifficultyName): void {
    for (const [id, e] of this.diffEls) e.classList.toggle("on", id === d);
  }

  /** The faint mark beside the gourd: the difficulty this fight runs on. */
  fightDifficulty(d: DifficultyName): void {
    const src = this.diffMarks.get(d) ?? "";
    if (this.diffMark.src !== src) this.diffMark.src = src;
    this.diffMark.dataset.difficulty = d;
  }

  private kanjiURL(text: string, color: string, seed: number): string {
    const key = text + color;
    let u = this.kanjiCache.get(key);
    if (!u) {
      u = brushText(text, { size: 300, color, seed, dry: 0.75, splatter: 0.8, font: KANJI_FONT, glow: "rgba(0,0,0,0.4)" }).toDataURL();
      this.kanjiCache.set(key, u);
    }
    return u;
  }

  /** Pre-render end-screen lettering so the reveal never hitches. */
  warm(): void {
    this.kanjiURL("勝利", "#f4ede2", 31);
    this.kanjiURL("敗北", "#b3261a", 32);
    this.kanjiURL("再起", "#d8e4e6", 33);
    for (const t of ["VICTORY", "DEFEAT", "RISE AGAIN"]) this.latinURL(t);
    for (const k of Object.values(PROMPTS)) this.smallURL(k);
  }

  /** Death with a resurrection left: rise again, or accept death. */
  showDeath(): void {
    this.show("death", this.kanjiURL("再起", "#d8e4e6", 33), this.latinURL("RISE AGAIN"));
    this.end.classList.add("prompt");
  }

  showEnd(kind: "victory" | "defeat"): void {
    if (kind === "victory") this.show(kind, this.kanjiURL("勝利", "#f4ede2", 31), this.latinURL("VICTORY"));
    else this.show(kind, this.kanjiURL("敗北", "#b3261a", 32), this.latinURL("DEFEAT"));
  }

  private show(kind: EndKind, kanji: string, latin: string): void {
    this.eKanji.src = kanji;
    this.eLatin.src = latin;
    this.ePress.src = this.smallURL(PROMPTS[kind]);
    this.end.dataset.kind = kind;
    this.end.classList.remove("hidden", "show", "prompt");
    void this.end.offsetWidth;
    this.end.classList.add("show");
  }

  showPrompt(): void {
    this.end.classList.add("prompt");
  }

  hideEnd(): void {
    this.end.classList.add("hidden");
    this.end.classList.remove("show", "prompt");
  }

  /** A deathblow took a marker: `left` remain. */
  markerTaken(left: number): void {
    this.shownMarkers = -1;
    this.setMarkers(left);
  }

  phase(n: number): void {
    this.bossbar.classList.toggle("p2", n === 2);
  }

  private setMarkers(n: number): void {
    if (n === this.shownMarkers) return;
    this.shownMarkers = n;
    this.markerEls.forEach((m, i) => m.classList.toggle("gone", i >= n));
  }

  update(
    dt: number,
    boss: { health: number; posture: number; broken: boolean; markers: number; limited: boolean },
    player: { health: number; posture: number; gourd: number; rez: number; limited: boolean },
  ): void {
    const bh = boss.health / 100;
    const ph = player.health / 100;
    if (bh < this.lastB) this.bLagHold = 0.5;
    if (ph < this.lastP) this.pLagHold = 0.5;
    this.pHpBar.classList.toggle("heal", ph > this.lastP + 1e-4);
    this.lastB = bh;
    this.lastP = ph;
    this.bLagHold -= dt;
    this.pLagHold -= dt;
    if (this.bLagHold <= 0) this.bLagV = Math.max(bh, this.bLagV - dt * 0.5);
    if (this.pLagHold <= 0) this.pLagV = Math.max(ph, this.pLagV - dt * 0.5);
    if (bh > this.bLagV) this.bLagV = bh;
    if (ph > this.pLagV) this.pLagV = ph;
    this.bHp.style.width = `${bh * 100}%`;
    this.bLag.style.width = `${this.bLagV * 100}%`;
    this.pHp.style.width = `${ph * 100}%`;
    this.pLag.style.width = `${this.pLagV * 100}%`;
    const bp = Math.min(100, boss.posture);
    this.bPostFill.style.width = `${boss.broken ? 100 : bp}%`;
    this.bPostFill.style.backgroundColor = boss.broken ? "" : ramp(bp / 100);
    this.bPost.classList.toggle("broken", boss.broken);
    this.bPost.classList.toggle("near", !boss.broken && bp > 85);
    this.bPost.classList.toggle("limited", boss.limited && bp > 1 && !boss.broken);
    this.bPost.style.opacity = bp > 1 || boss.broken ? "1" : "0.35";
    const pp = Math.min(100, player.posture);
    this.pPostFill.style.width = `${pp}%`;
    this.pPostFill.style.backgroundColor = ramp(pp / 100);
    this.pPost.classList.toggle("near", pp > 85);
    // The wiki's cue: the gauge flashes red while low vitality is holding its recovery back.
    this.pPost.classList.toggle("limited", player.limited && pp > 1);
    this.pPost.style.opacity = pp > 1 ? "1" : "0.3";
    this.setMarkers(boss.markers);
    if (player.gourd !== this.shownGourd) {
      this.shownGourd = player.gourd;
      this.gourdN.textContent = String(player.gourd);
      this.gourdEl.classList.toggle("empty", player.gourd <= 0);
    }
    if (player.rez !== this.shownRez) {
      this.shownRez = player.rez;
      this.rezEl.classList.toggle("spent", player.rez <= 0);
    }
  }
}
