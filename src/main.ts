import * as THREE from "three";
import { loadBodies } from "./chars/loadBodies";
import { activeDifficulty, DIFFICULTY, DIFFICULTY_PRESETS, type DifficultyName } from "./game/difficulty";
import { Input } from "./core/Input";
import { deflectPosture, Game, KICK_HEAD_POSTURE, MIKIRI_POSTURE } from "./game/Game";
import { GOURD, REZ } from "./game/Player";
import { wavedash } from "./wavedash";

const canvas = document.getElementById("game") as HTMLCanvasElement;
const hud = document.getElementById("hud") as HTMLElement;
wavedash.progress(0.2);
const game = new Game(canvas, hud);
game.start();
wavedash.ready();
const bodies = loadBodies({ player: game.shinobi, boss: game.general }, (who, body) => game.useBody(who, body));
if (new URLSearchParams(location.search).get("debug") === "anim") void import("./debug/AnimDebug").then((m) => m.mountAnimDebug(game));

type SceneName = "title" | "fight" | "thrust" | "overhead" | "deflect" | "break" | "finisher" | "finisher2" | "victory" | "portrait" | "portrait2" | "closeP" | "closeB" | "closeP2";

function until(pred: () => boolean, max = 6, dt = 1 / 60): boolean {
  for (let t = 0; t < max; t += dt) {
    if (pred()) return true;
    game.step(dt);
  }
  return pred();
}

/** Deterministic set pieces for screenshots and checks (pauses the real-time loop). */
function scene(name: SceneName): Record<string, unknown> {
  game.pause();
  const b = game.boss;
  const s = game.stats;
  const close = (d: number) => {
    game.startFight();
    game.place(d);
    b.cooldown = 99;
    game.step(0.5);
  };
  game.cam.override = null;
  switch (name) {
    case "portrait":
    case "portrait2": {
      close(3);
      game.step(0.6);
      const back = name === "portrait2";
      game.cam.override = {
        pos: new THREE.Vector3(back ? -2.2 : 3.2, 1.5, back ? -5.5 : 1.2),
        look: new THREE.Vector3(0, 1.2, back ? 0 : -0.5),
      };
      game.step(0.1);
      break;
    }
    case "closeP":
    case "closeP2":
    case "closeB": {
      close(3);
      game.step(0.6);
      const P = game.player.pos;
      const B = game.boss.pos;
      game.cam.override =
        name === "closeB"
          ? { pos: new THREE.Vector3(B.x + 1.6, 1.7, B.z + 2.3), look: new THREE.Vector3(B.x, 1.45, B.z) }
          : name === "closeP"
            ? { pos: new THREE.Vector3(P.x - 1.3, 1.35, P.z - 1.4), look: new THREE.Vector3(P.x, 1.05, P.z) }
            : { pos: new THREE.Vector3(P.x + 1.2, 1.4, P.z + 1.6), look: new THREE.Vector3(P.x, 1.05, P.z) };
      game.step(0.1);
      break;
    }
    case "finisher2":
      scene("break");
      game.bot.deflect = false;
      game.startFinisher();
      until(() => game.player.stateT >= 0.75, 4, 1 / 120);
      break;
    case "title":
      game.toTitle();
      game.step(2.5);
      break;
    case "fight":
      game.startFight();
      game.step(1.95);
      break;
    case "thrust":
      close(3.4);
      game.forceBossAttack("thrust");
      game.step(0.5);
      break;
    case "overhead":
      close(3);
      game.forceBossAttack("overhead");
      game.step(0.95);
      break;
    case "deflect": {
      close(2.6);
      game.bot.deflect = true;
      const n = s.deflects;
      game.forceBossAttack("combo");
      until(() => s.deflects > n, 3, 1 / 120);
      game.step(3 / 60);
      break;
    }
    case "break":
    case "finisher":
    case "victory": {
      close(2.6);
      game.bot.deflect = true;
      b.posture = 96;
      const n = s.breaks;
      game.forceBossAttack("overhead");
      until(() => s.breaks > n, 4, 1 / 120);
      game.step(0.45);
      if (name === "break") break;
      game.bot.deflect = false;
      game.startFinisher();
      until(() => game.player.stateT >= 0.5, 3, 1 / 120);
      if (name === "finisher") break;
      until(() => game.state === "victory", 8);
      game.step(0.3);
      break;
    }
  }
  return stats();
}

function stats(): Record<string, unknown> {
  return {
    renderer: game.rendererName,
    fps: +game.fps.toFixed(1),
    state: game.state,
    player: { health: game.player.health, posture: +game.player.posture.toFixed(1), state: game.player.state },
    boss: { health: +game.boss.health.toFixed(1), posture: +game.boss.posture.toFixed(1), state: game.boss.state, attack: game.boss.attack?.name ?? null },
    ...game.stats,
    drawCalls: game.renderer.info.render.calls,
    triangles: game.renderer.info.render.triangles,
  };
}

declare global {
  interface Window {
    __duel: Record<string, unknown>;
  }
}

window.__duel = {
  ready: false,
  game,
  stats,
  rules: {
    DIFFICULTY,
    DIFFICULTY_PRESETS,
    get DEFLECT_POSTURE() {
      return DIFFICULTY.deflectPosture;
    },
    deflectPosture,
    MIKIRI_POSTURE,
    KICK_HEAD_POSTURE,
    GOURD,
    REZ,
    DEFLECT_STEPS: Input.DEFLECT_STEPS,
    MASH_RESET: Input.MASH_RESET,
  },
  /** Difficulty for the next fight ('easy' | 'medium' | 'hard'); `difficulty()` → [chosen, running]. */
  setDifficulty: (d: DifficultyName) => game.setDifficulty(d),
  difficulty: () => [game.difficulty, activeDifficulty()],
  scene,
  step: (s: number) => game.step(s),
  pause: () => game.pause(),
  resume: () => game.resume(),
  startFight: () => game.startFight(),
  toTitle: () => game.toTitle(),
  forceBossAttack: (n: string) => game.forceBossAttack(n),
  autoDeflect: (on: boolean) => {
    game.bot.deflect = on;
  },
  autoPlay: (on: boolean) => {
    game.bot.deflect = on;
    game.bot.play = on;
  },
};

// The rooftop (arena.glb + sky HDRI) streams in behind the title; `ready` waits for it and for its
// shaders, so the first fight never compiles programs.
const loading = document.createElement("div");
loading.textContent = "the castle rises from the mist…";
loading.style.cssText =
  "position:fixed;left:0;right:0;bottom:5%;text-align:center;font:italic 15px Georgia,serif;letter-spacing:.12em;color:rgba(236,226,214,.72);pointer-events:none;transition:opacity .6s";
document.body.append(loading);
/**
 * The arena adds materials and lantern lights (which changes every program's light hash), so compile
 * the whole scene again, hidden combat fx included, the way the composer draws it: into a linear
 * render target. Programs are created synchronously inside compileAsync, so the fx are only
 * un-hidden for that call and never reach the screen.
 */
function warmArena(): Promise<void> {
  const r = game.renderer;
  const hidden: THREE.Object3D[] = [];
  game.scene.traverse((o) => {
    if (!o.visible) {
      hidden.push(o);
      o.visible = true;
    }
  });
  const rt = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType });
  const prev = r.getRenderTarget();
  r.setRenderTarget(rt);
  const done = r.compileAsync(game.scene, game.camera);
  r.setRenderTarget(prev);
  for (const o of hidden) o.visible = false;
  return done.then(() => rt.dispose());
}
// The skinned bodies (and their rim-lit materials) are compiled in the same pass.
game.arena
  .load(game.renderer)
  .then(() => bodies.catch(() => undefined))
  // Lighting agent: rim-tag the fighters' armour before the warm-up so it compiles with everything else.
  .then(() => game.arena.tagCharacterRim())
  .then(warmArena)
  .catch((e: unknown) => console.error("[arena] failed to load", e))
  .finally(() => {
    loading.style.opacity = "0";
    setTimeout(() => loading.remove(), 700);
    window.__duel.ready = true;
  });

// Dev-only hooks for tools/skin-smoke.mjs (stripped from production builds).
if (import.meta.env.DEV) {
  window.__duel.dev = {
    three: () => Promise.resolve(THREE),
    skinned: () => import("./chars/SkinnedCharacter"),
    config: () => import("./chars/skinnedConfig"),
    gltf: () => import("three/addons/loaders/GLTFLoader.js"),
    exporter: () => import("three/addons/exporters/GLTFExporter.js"),
  };
}
