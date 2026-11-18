// Mechanics checks: deterministic, scripted through window.__duel.game with the loop paused.
// Usage: node tools/mech.mjs   (prints PASS/FAIL per check; exit 1 on any failure)
import { launch } from "./gpu.mjs";

const { browser, page, errors } = await launch({ width: 1280, height: 720 });

const results = await page.evaluate(() => {
  const g = window.__duel.game;
  const FD = 1 / 120;
  const out = [];
  const check = (name, ok, detail) => out.push({ name, ok: !!ok, detail });
  g.pause();
  const inp = g.input;
  const p = g.player;
  const b = g.boss;

  const frame = () => {
    g.fixed(FD);
    g.fixed(FD);
    g.frame(1 / 60, false);
  };
  const run = (sec, each) => {
    const n = Math.round(sec * 60);
    for (let i = 0; i < n; i++) {
      frame();
      if (each && each(i) === false) return i;
    }
    return n;
  };
  const tap = (a) => {
    inp.press(a);
    inp.release(a);
  };
  const fresh = (dist = 3) => {
    g.startFight();
    g.bot.play = false;
    g.bot.deflect = false;
    inp.botAxis = null;
    for (const a of ["attack", "block", "dodge", "jump", "lock", "heal"]) {
      inp.release(a);
      inp.release(a, "KeyK");
      inp.release(a, "Mouse2");
      inp.consume(a, 99);
    }
    b.passive = true;
    b.enter("idle");
    b.attack = null;
    g.place(dist);
    run(0.1);
    inp.resetMash();
  };
  const hspeed = () => Math.hypot(p.vel.x, p.vel.z);
  const ang = (a) => Math.atan2(Math.sin(a), Math.cos(a));

  // ------------------------------------------------------------ 1. input
  {
    fresh(4);
    const tip0 = p.ch.rig.tipW.clone();
    tap("attack");
    let tState = -1;
    let tMove = -1;
    run(0.2, (i) => {
      if (tState < 0 && p.state === "attack") tState = (i + 1) / 60;
      if (tMove < 0 && p.ch.rig.tipW.distanceTo(tip0) > 0.05) tMove = (i + 1) / 60;
    });
    check("input: attack responds <=100 ms", tState >= 0 && tState <= 0.1 && tMove >= 0 && tMove <= 0.1, `state ${tState.toFixed(3)} s, blade moves ${tMove.toFixed(3)} s`);

    fresh(4);
    inp.press("block");
    let tB = -1;
    run(0.1, (i) => {
      if (tB < 0 && (p.state === "deflect" || p.guarding)) tB = (i + 1) / 60;
    });
    inp.release("block");
    check("input: block responds <=100 ms", tB >= 0 && tB <= 0.1, `${tB.toFixed(3)} s`);

    fresh(4);
    const d0 = p.pos.clone();
    tap("dodge");
    let tD = -1;
    run(0.1, (i) => {
      if (tD < 0 && p.state === "dodge" && p.pos.distanceTo(d0) > 0.05) tD = (i + 1) / 60;
    });
    check("input: dodge responds <=100 ms", tD >= 0 && tD <= 0.1, `${tD.toFixed(3)} s`);

    fresh(4);
    tap("jump");
    let tJ = -1;
    run(0.1, (i) => {
      if (tJ < 0 && p.pos.y > 0.03) tJ = (i + 1) / 60;
    });
    check("input: jump responds <=100 ms", tJ >= 0 && tJ <= 0.1, `${tJ.toFixed(3)} s`);

    // Buffer: attack pressed mid-hitstun fires as soon as the stagger ends.
    fresh(4);
    p.takeHit(b.pos);
    run(0.2);
    tap("attack");
    let recEnd = -1;
    let atk = -1;
    run(0.6, (i) => {
      if (recEnd < 0 && p.state !== "hit") recEnd = i;
      if (atk < 0 && p.state === "attack") atk = i;
    });
    check("input: attack buffered through hitstun", atk >= 0 && atk - recEnd <= 1, `recovery ended frame ${recEnd}, attack frame ${atk}`);

    // Buffer: dodge pressed mid-swing fires once the swing is cancellable.
    fresh(4);
    tap("attack");
    run(0.05);
    tap("dodge");
    let dodgeAt = -1;
    run(0.6, (i) => {
      if (dodgeAt < 0 && p.state === "dodge") dodgeAt = (i + 1) / 60 + 0.05;
    });
    check("input: dodge buffered through swing", dodgeAt > 0 && dodgeAt < 0.45, `dodge at ${dodgeAt.toFixed(3)} s into the swing`);

    // Combo 1 -> 2 -> 3 on timed presses, then a clean reset to 1.
    fresh(1.6);
    const seen = [];
    tap("attack");
    run(1.8, (i) => {
      // Keep him open (no guard counter) so only the combo timing is under test.
      b.state = "recoil";
      b.stateT = 0.1;
      if (p.state === "attack" && seen[seen.length - 1] !== p.combo + ":" + p.swing.clip) seen.push(p.combo + ":" + p.swing.clip);
      if (p.state === "attack" && p.stateT > 0.18 && p.stateT < 0.2 && p.combo < 2) tap("attack");
    });
    const endState = p.state;
    tap("attack");
    run(0.05);
    check("input: combo chains 1-2-3 and resets", seen.join(",") === "0:attack1,1:attack2,2:attack3" && endState === "move" && p.combo === 0, `${seen.join(",")} then ${endState}, next combo ${p.combo}`);

    // Nothing stuck: hitstop resolves, guard releases, attack ends.
    fresh(3);
    g.hitstop = 0.07;
    inp.press("block");
    run(0.3);
    inp.release("block");
    run(0.1);
    const guardOk = !p.guarding;
    tap("attack");
    run(1.2);
    check("input: no stuck guard/attack/hitstop", guardOk && p.state === "move" && g.hitstop <= 0 && g.timeScale > 0.9, `guarding=${p.guarding} state=${p.state} hitstop=${g.hitstop.toFixed(3)} ts=${g.timeScale.toFixed(2)}`);
  }

  // ------------------------------------------------------------ 2. movement
  {
    fresh(6);
    inp.botAxis = { x: 0, y: 1 };
    run(0.05);
    const v50 = hspeed();
    run(0.35);
    const v400 = hspeed();
    inp.botAxis = null;
    run(0.05);
    const vStop = hspeed();
    run(0.5);
    check("move: accelerates and decelerates smoothly", v50 > 0.3 && v50 < 2.4 && v400 > 2.6 && vStop > 0.3 && vStop < v400 && hspeed() < 0.05, `v@50ms ${v50.toFixed(2)}, v@400ms ${v400.toFixed(2)}, 50 ms after release ${vStop.toFixed(2)}, settled ${hspeed().toFixed(3)}`);

    fresh(4);
    inp.botAxis = { x: 1, y: 0 };
    let worst = 0;
    run(2, (i) => {
      if (i > 20) {
        const face = Math.atan2(b.pos.x - p.pos.x, b.pos.z - p.pos.z);
        worst = Math.max(worst, Math.abs(ang(p.yaw - face)));
      }
    });
    inp.botAxis = null;
    check("move: locked strafe keeps facing the boss", worst < 0.15, `worst yaw error ${worst.toFixed(3)} rad`);

    fresh(6);
    inp.botAxis = { x: 0, y: -1 };
    inp.press("dodge");
    run(0.9);
    const running = p.running;
    const vRun = hspeed();
    inp.release("dodge");
    run(0.3);
    inp.botAxis = null;
    check("move: holding Shift after the step sprints, well above the jog", running && vRun > 6.8, `running=${running} speed ${vRun.toFixed(2)}`);

    const dists = [];
    for (const ax of [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: -1 }, { x: 0.7, y: -0.7 }]) {
      fresh(5);
      p.pos.set(0, 0, 3);
      g.place(5);
      inp.botAxis = ax;
      const s0 = p.pos.clone();
      tap("dodge");
      run(0.5);
      inp.botAxis = null;
      dists.push(Math.hypot(p.pos.x - s0.x, p.pos.z - s0.z));
    }
    const spread = Math.max(...dists) - Math.min(...dists);
    check("move: dodge distance consistent", spread < 0.12 && Math.min(...dists) > 1.2, dists.map((d) => d.toFixed(2)).join(" / ") + " m");

    // i-frames vs the thrust: side-step so the blade still reaches the body during the dodge.
    const thrust = (dodge) => {
      fresh(3.2);
      const h0 = g.stats.hitsTaken;
      const dg0 = g.stats.dodged;
      g.forceBossAttack("thrust");
      // Back-step just before contact (a step *into* it would be the mikiri): the lunge still
      // reaches him, only the i-frames save him.
      const contact = 0.9;
      run(2.0, () => {
        if (dodge && p.state === "move" && b.state === "attack" && b.stateT >= contact - 0.07) {
          inp.botAxis = { x: 0, y: -1 };
          tap("dodge");
        }
      });
      inp.botAxis = null;
      return { hit: g.stats.hitsTaken - h0, dodged: g.stats.dodged - dg0 };
    };
    const noDodge = thrust(false);
    const withDodge = thrust(true);
    check("move: dodge i-frames beat the thrust", noDodge.hit === 1 && withDodge.hit === 0 && withDodge.dodged >= 1, `standing: hit ${noDodge.hit}; dodging: hit ${withDodge.hit}, i-frame saves ${withDodge.dodged}`);

    fresh(5);
    tap("jump");
    let peak = 0;
    let air = 0;
    run(1.2, () => {
      peak = Math.max(peak, p.pos.y);
      if (p.pos.y > 0) air += 1 / 60;
    });
    check("move: jump is a small clean hop", peak > 0.4 && peak < 0.9 && air < 0.8 && p.state === "move" && p.pos.y === 0, `peak ${peak.toFixed(2)} m, airborne ${air.toFixed(2)} s, lands in ${p.state}`);

    const edges = [];
    for (const ax of [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }]) {
      fresh(5);
      g.locked = false;
      g.cam.setMode("free");
      g.cam.yaw = Math.PI;
      inp.botAxis = ax;
      inp.press("dodge");
      run(6);
      inp.release("dodge");
      inp.botAxis = null;
      edges.push([p.pos.x, p.pos.z]);
    }
    const LIM = 11.2 + 1e-6;
    const wallsOk = edges.every(([x, z]) => Math.abs(x) <= LIM && z <= LIM && z >= -13.2 + 1.3 - 1e-6);
    check("move: invisible walls hold on every edge + ridge", wallsOk, edges.map(([x, z]) => `(${x.toFixed(2)},${z.toFixed(2)})`).join(" "));

    fresh(0.2);
    inp.botAxis = { x: 0, y: 1 };
    let minD = 99;
    run(2, () => {
      if (b.pos.y < 0.3) minD = Math.min(minD, Math.hypot(p.pos.x - b.pos.x, p.pos.z - b.pos.z));
    });
    inp.botAxis = null;
    check("move: fighters never overlap", minD >= 1.0, `closest ${minD.toFixed(3)} m while walking into him`);

    // Interpolation: at alpha 0.5 the drawn body sits halfway between the last two sim steps.
    fresh(4);
    inp.botAxis = { x: 0, y: 1 };
    run(0.5);
    g.fixed(FD);
    g.frame(0, false, 0.5);
    const k = g.interp.p.length();
    const step = Math.hypot(p.vel.x, p.vel.z) * FD;
    inp.botAxis = null;
    check("move: render interpolation uses the loop alpha", Math.abs(k - step * 0.5) < step * 0.2, `offset ${(k * 1000).toFixed(2)} mm for a ${(step * 1000).toFixed(2)} mm step`);
  }

  // ------------------------------------------------------------ 3. camera
  {
    const camRun = (sec) => {
      let jump = 0;
      let flip = 0;
      let bad = 0;
      const prev = g.camera.position.clone();
      const prevDir = g.camera.getWorldDirection(g.camera.position.clone());
      const dir = prevDir.clone();
      run(sec, () => {
        const c = g.camera.position;
        if (!Number.isFinite(c.x + c.y + c.z)) bad++;
        jump = Math.max(jump, c.distanceTo(prev));
        g.camera.getWorldDirection(dir);
        flip = Math.max(flip, dir.angleTo(prevDir));
        prev.copy(c);
        prevDir.copy(dir);
      });
      return { jump, flip, bad };
    };
    fresh(6);
    g.cam.setMode("lock");
    run(1);
    g.forceBossAttack("leap");
    // Put the player right under the landing so the general passes overhead.
    const leap = camRun(2.5);
    fresh(0.3);
    run(0.5);
    const close = camRun(2);
    check("camera: lock-on smooth on leap + point blank", leap.bad + close.bad === 0 && leap.flip < 0.12 && close.flip < 0.12 && leap.jump < 0.35 && close.jump < 0.35, `leap: max ${leap.jump.toFixed(3)} m / ${leap.flip.toFixed(3)} rad per frame; close: ${close.jump.toFixed(3)} m / ${close.flip.toFixed(3)} rad`);

    fresh(4);
    tap("lock");
    run(0.2);
    const off = !g.locked && g.cam.mode === "free";
    const y0 = g.cam.yaw;
    inp.mouseDX = 300;
    run(0.1);
    const dYaw = ang(g.cam.yaw - y0);
    const turned = Math.abs(dYaw) > 0.3;
    tap("lock");
    run(0.2);
    check("camera: Q/MMB toggles lock, free look turns", off && turned && g.locked && g.cam.mode === "lock", `free=${off} 300 px mouse turned ${dYaw.toFixed(2)} rad, relocked=${g.locked}`);

    // Clipping: sweep the player along every wall and the ridge in both modes.
    let worstY = 99;
    let worstZ = 99;
    let worstBody = 99;
    for (const mode of ["lock", "free"]) {
      for (const [x, z] of [[-11, -11.9], [11, -11.9], [0, -11.9], [-11, 11], [11, 11], [0, 11]]) {
        fresh(3);
        p.pos.set(x, 0, z);
        b.pos.set(x * 0.7, 0, z + (z < 0 ? 3 : -3));
        g.locked = mode === "lock";
        g.cam.setMode(mode);
        run(1.2, () => {
          const c = g.camera.position;
          worstY = Math.min(worstY, c.y);
          worstZ = Math.min(worstZ, c.z - (-13.2));
          worstBody = Math.min(worstBody, c.distanceTo(p.ch.rig.chestW), c.distanceTo(b.ch.rig.chestW));
        });
      }
    }
    check("camera: never inside roof, ridge or bodies", worstY > 0.35 && worstZ > 0.3 && worstBody > 0.45, `min height ${worstY.toFixed(2)}, min gap to ridge ${worstZ.toFixed(2)}, min distance to a chest ${worstBody.toFixed(2)}`);

    fresh(4);
    g.cam.shake(1);
    let tr = 0;
    run(2, (i) => {
      if (g.cam.trauma < 0.01 && !tr) tr = (i + 1) / 60;
    });
    check("camera: shake decays cleanly", tr > 0 && tr < 1.6 && g.cam.trauma === 0 || (tr > 0 && g.cam.trauma < 1e-3), `trauma < 1% after ${tr.toFixed(2)} s`);
  }

  // ------------------------------------------------------------ 4. combat
  {
    // Deflect window: tap block at an offset from the overhead's contact.
    const probe = (offMs) => {
      fresh(2.2);
      const s0 = { ...g.stats };
      g.forceBossAttack("overhead");
      const contact = b.attack.hits[0].contact;
      let pressed = false;
      run(2.2, () => {
        if (!pressed && b.state === "attack" && b.stateT >= contact + offMs / 1000) {
          pressed = true;
          inp.press("block");
          inp.release("block");
        }
      });
      const r = g.stats.deflects > s0.deflects ? "deflect" : g.stats.blocks > s0.blocks ? "block" : g.stats.hitsTaken > s0.hitsTaken ? "hit" : "none";
      return r;
    };
    // Window: DIFFICULTY.deflectEarly (0.25 s) before the blow, deflectLate (0.06 s) after.
    const offs = [-310, -240, -150, -50, 0, 50, 90];
    const res = offs.map((o) => [o, probe(o)]);
    const expect = { "-310": ["hit"], "-240": ["deflect", "hit"], "-150": ["deflect"], "-50": ["deflect"], 0: ["deflect"], 50: ["deflect"], 90: ["hit"] };
    const ok = res.every(([o, r]) => expect[o].includes(r));
    check("combat: deflect window boundaries", ok, res.map(([o, r]) => `${o}ms:${r}`).join(" "));

    // Holding guard well before contact = regular block.
    fresh(2.2);
    const bl0 = g.stats.blocks;
    inp.press("block");
    g.forceBossAttack("overhead");
    run(2.0);
    inp.release("block");
    check("combat: held guard = regular block", g.stats.blocks === bl0 + 1, `blocks +${g.stats.blocks - bl0}, hp ${p.health}`);

    // One hit per swing (player on boss, boss on player).
    fresh(1.5);
    b.state = "recoil";
    b.stateT = 0;
    const ph0 = g.stats.playerHits;
    tap("attack");
    run(0.6);
    const perSwing = g.stats.playerHits - ph0;
    fresh(2.0);
    const ht0 = g.stats.hitsTaken;
    g.forceBossAttack("overhead");
    run(2.0);
    check("combat: a swing lands at most once", perSwing === 1 && g.stats.hitsTaken - ht0 === 1, `player swing hits ${perSwing}, boss overhead hits ${g.stats.hitsTaken - ht0}`);

    // Thrust (wiki: can't be guarded, can be deflected): held guard eats it, a timed tap deflects it.
    const thrustVs = (how) => {
      fresh(3.2);
      const s0 = { ...g.stats };
      if (how === "hold") inp.press("block", "KeyK");
      g.forceBossAttack("thrust");
      const c = b.attack.hits[0].contact;
      let pr = false;
      run(2, () => {
        if (how === "tap" && !pr && b.state === "attack" && b.stateT >= c - 0.08) {
          pr = true;
          tap("block");
        }
      });
      inp.release("block", "KeyK");
      return { d: g.stats.deflects - s0.deflects, bl: g.stats.blocks - s0.blocks, h: g.stats.hitsTaken - s0.hitsTaken };
    };
    const thHold = thrustVs("hold");
    const thTap = thrustVs("tap");
    check("combat: thrust goes through a held guard, a timed deflect turns it", thHold.h === 1 && thHold.bl === 0 && thTap.d === 1 && thTap.h === 0, `held guard: hit ${thHold.h} blocked ${thHold.bl}; timed tap: deflects ${thTap.d} hits ${thTap.h}`);

    // Posture regen (wiki: enemies have no delay, none while attacking) and break at exactly 100.
    fresh(3);
    b.posture = 60;
    b.postureIdle = 0;
    run(1.0);
    const regen1 = b.posture;
    fresh(3);
    b.posture = 60;
    g.forceBossAttack("overhead");
    b.cooldown = 99;
    run(0.9);
    const hold = b.posture;
    const regen = regen1;
    const dp = window.__duel.rules.deflectPosture({ heavy: true }, 0);
    fresh(2.2);
    b.posture = 100 - dp - 0.1;
    g.forceBossAttack("overhead");
    let pr2 = false;
    run(2.2, () => {
      if (!pr2 && b.state === "attack" && b.stateT >= b.attack.hits[0].contact - 0.08) {
        pr2 = true;
        tap("block");
      }
    });
    const under = b.state;
    const underPost = b.posture;
    fresh(2.2);
    b.posture = 100 - dp;
    g.forceBossAttack("overhead");
    let pr3 = false;
    run(1.6, () => {
      if (!pr3 && b.state === "attack" && b.stateT >= b.attack.hits[0].contact - 0.08) {
        pr3 = true;
        tap("block");
      }
    });
    check("combat: posture regen (none while attacking) + break at exactly 100", hold === 60 && regen < 60 && under !== "stagger" && b.state === "stagger", `idle 1 s: 60 -> ${regen.toFixed(1)}; attacking 0.9 s: 60 -> ${hold.toFixed(1)}; ${(100 - dp - 0.1).toFixed(1)}+${dp} -> ${under} (${underPost.toFixed(1)}); ${100 - dp}+${dp} -> ${b.state}`);

    // Deathblow only when staggered and in range; the first marker gets the short deathblow, the last the finisher.
    fresh(2);
    tap("attack");
    run(0.1);
    const notStag = g.state;
    fresh(5);
    b.stagger();
    tap("attack");
    run(0.1);
    const far = g.state;
    fresh(2);
    b.stagger();
    tap("attack");
    run(0.1);
    const first = g.state;
    fresh(2);
    b.markers = 1;
    b.stagger();
    tap("attack");
    run(0.1);
    check("combat: deathblow only staggered + in range (short one first, finisher last)", notStag === "fight" && far === "fight" && first === "deathblow" && g.state === "finisher", `not staggered -> ${notStag}; staggered at 5 m -> ${far}; at 2 m with 2 markers -> ${first}; with 1 marker -> ${g.state}`);

    // Guard break, then recovery.
    fresh(2.2);
    p.posture = 95;
    p.postureIdle = -1.5;
    inp.press("block");
    g.forceBossAttack("overhead");
    let gb = false;
    run(2.0, () => {
      if (p.state === "guardbreak") gb = true;
    });
    inp.release("block");
    run(1.5);
    check("combat: player guard break + recovery", gb && p.state === "move", `guardbreak=${gb}, then ${p.state} (posture ${p.posture.toFixed(0)})`);

    // Death -> resurrect (boss keeps his state) -> death -> defeat -> one confirm restarts clean.
    const killNow = () => {
      p.health = 1;
      p.enter("move");
      g.place(2.2);
      b.passive = false;
      g.forceBossAttack("overhead");
      run(2.0);
    };
    fresh(2.2);
    b.health = 58;
    b.posture = 40;
    killNow();
    const dead = g.state;
    const early = inp.promptPress("Enter");
    run(1.6);
    const rezOk = inp.promptPress("Enter");
    run(0.05);
    const afterRez = { st: g.state, ps: p.state, hp: p.health, rez: p.rez, bh: b.health, bm: b.markers };
    run(2.0);
    const again = inp.promptPress("Enter");
    killNow();
    run(1.5);
    const defeat = g.state;
    const f0 = g.fightsStarted;
    run(1.5);
    inp.promptPress("Enter");
    run(0.05);
    const splats = g.fx.splats.mesh.count + g.fx.ink.alive + g.fx.sparks.alive + g.fx.smoke.alive;
    const reset = p.health === 100 && p.posture === 0 && p.rez === 1 && p.gourd === 3 && b.health === 100 && b.markers === 2 && Math.abs(p.pos.z - 4) < 0.3;
    check(
      "combat: death -> resurrect -> death -> defeat -> restart",
      dead === "dying" && !early && rezOk === "confirm" && afterRez.st === "fight" && afterRez.ps === "revive" && afterRez.hp === 50 && afterRez.rez === 0 && Math.abs(afterRez.bh - 58) < 1 && !again && defeat === "defeat" && g.fightsStarted === f0 + 1 && reset && splats === 0,
      `died -> ${dead} (early key ${early}), rise -> ${afterRez.st}/${afterRez.ps} hp ${afterRez.hp} rez ${afterRez.rez}, boss kept ${afterRez.bh.toFixed(0)} hp ${afterRez.bm} markers; stray key after rising ${again}; 2nd death -> ${defeat}; restart: fights +${g.fightsStarted - f0}, player ${p.health}/${p.rez}/${p.gourd}, boss ${b.health}/${b.markers}, splats ${splats}`,
    );
  }

  // ------------------------------------------------------------ 5. ruleset (wiki)
  {
    const R = window.__duel.rules;
    const deflectRun = (atk, presses, opts = {}) => {
      fresh(opts.dist ?? 2.4);
      if (opts.phase2) g.forceBossAttack; // placeholder for readability
      const s0 = { ...g.stats };
      if (opts.holdFrom) inp.press("block", "KeyK");
      g.forceBossAttack(atk);
      const hits = b.attack.hits.map((h) => h.contact);
      const plan = [];
      for (const c of hits) for (const off of presses) plan.push({ at: c + off, done: false, up: -1 });
      run(4, () => {
        const t = b.state === "attack" ? b.stateT : -1;
        for (const q of plan) {
          if (!q.done && t >= q.at) {
            q.done = true;
            inp.press("block", opts.src ?? "Mouse2");
            q.up = g.gameTime + (opts.tapLen ?? 0.06);
          }
          if (q.up > 0 && g.gameTime >= q.up && !opts.keepHeld) {
            q.up = -1;
            inp.release("block", opts.src ?? "Mouse2");
          }
        }
        if (b.state !== "attack" && plan.every((q) => q.done)) return false;
      });
      inp.release("block", "KeyK");
      inp.release("block", "Mouse2");
      return { n: hits.length, d: g.stats.deflects - s0.deflects, bl: g.stats.blocks - s0.blocks, h: g.stats.hitsTaken - s0.hitsTaken, end: `${b.state} post ${b.posture.toFixed(0)} dist ${Math.hypot(b.pos.x - p.pos.x, b.pos.z - p.pos.z).toFixed(2)}` };
    };
    // A human tapping twice per blow (~0.28 s and ~0.08 s before each) still deflects every blow.
    const spamC = deflectRun("combo", [-0.28, -0.08]);
    const spamF = deflectRun("flurry", [-0.2, -0.07]);
    // (A fully deflected flurry may break his posture before its last blow: that also counts.)
    const allF = spamF.h === 0 && spamF.bl === 0 && (spamF.d === spamF.n || spamF.end.startsWith("stagger"));
    check("deflect: tapping twice per blow still deflects every blow (combo + 5-hit flurry)", spamC.d === spamC.n && allF, `combo ${spamC.d}/${spamC.n} deflected (${spamC.h} hits ${spamC.bl} blocks), flurry ${spamF.d}/${spamF.n} (${spamF.h} hits ${spamF.bl} blocks, ended ${spamF.end})`);

    // Holding guard (K) and re-tapping (RMB) just before the blow is a fresh deflect, not a block.
    const retap = deflectRun("overhead", [-0.08], { holdFrom: true });
    // Holding, releasing right before and re-pressing is also still a deflect.
    fresh(2.2);
    const s1 = { ...g.stats };
    inp.press("block", "KeyK");
    g.forceBossAttack("overhead");
    const c1 = b.attack.hits[0].contact;
    let st1 = 0;
    run(2.2, () => {
      if (st1 === 0 && b.stateT >= c1 - 0.14) {
        st1 = 1;
        inp.release("block", "KeyK");
      }
      if (st1 === 1 && b.stateT >= c1 - 0.08) {
        st1 = 2;
        inp.press("block", "KeyK");
      }
    });
    inp.release("block", "KeyK");
    const relRe = g.stats.deflects - s1.deflects;
    check("deflect: re-tapping while holding guard, or release + re-press, gives a fresh window", retap.d === 1 && retap.bl === 0 && relRe === 1, `hold K + tap RMB: deflect ${retap.d} block ${retap.bl}; release + re-press 60 ms apart: deflect ${relRe}`);

    // Mash floor: ten presses in a row never shrink the window below 0.1 s; it resets after 0.5 s up.
    fresh(3);
    let minW = 1;
    for (let i = 0; i < 10; i++) {
      inp.press("block");
      minW = Math.min(minW, inp.deflectWindow);
      run(0.05);
      inp.release("block");
      run(0.05);
    }
    run(0.6);
    inp.press("block");
    const after = inp.deflectWindow;
    inp.release("block");
    // Holding one binding and mashing another is mashing too.
    inp.resetMash();
    inp.press("block", "KeyK");
    run(0.6);
    let heldMash = 1;
    for (let i = 0; i < 6; i++) {
      inp.press("block", "Mouse2");
      heldMash = Math.min(heldMash, inp.deflectWindow);
      run(0.05);
      inp.release("block", "Mouse2");
      run(0.05);
    }
    inp.release("block", "KeyK");
    check("deflect: mash penalty is gentle, never 0, clears after 0.5 s, and counts every binding", minW >= R.DEFLECT_STEPS.at(-1) - 1e-9 && after === R.DEFLECT_STEPS[0] && R.DEFLECT_STEPS[1] === R.DEFLECT_STEPS[0] && heldMash < R.DEFLECT_STEPS[0] && heldMash >= R.DEFLECT_STEPS.at(-1) - 1e-9, `window after 10 rapid presses ${minW.toFixed(3)} s (steps ${R.DEFLECT_STEPS.join("/")}), after 0.6 s released ${after} s; hold K + mash RMB -> ${heldMash.toFixed(3)} s`);

    // After he turns a cut aside, his answering string can be deflected from its first blow.
    fresh(1.6);
    b.passive = false;
    b.cooldown = 99;
    const cs0 = { ...g.stats };
    let flurrySeen = false;
    const pressedAt = new Set();
    // Cut until he turns one aside, then wait on guard for his answer (it comes after a beat).
    const cd0 = g.stats.bossDeflects;
    for (let i = 0; i < 12 && g.stats.bossDeflects === cd0; i++) {
      tap("attack");
      run(0.4);
    }
    run(1.2, () => {
      if (b.state === "attack" && (b.attack.name === "flurry" || b.attack.name === "combo")) {
        flurrySeen = true;
        return false;
      }
    });
    run(3, () => {
      if (b.state === "attack" && b.attack) {
        b.attack.hits.forEach((h, j) => {
          if (!pressedAt.has(j) && b.stateT >= h.contact - 0.08 * b.tempo) {
            pressedAt.add(j);
            tap("block");
          }
        });
      }
      if (b.state !== "attack" && pressedAt.size) return false;
    });
    check("deflect: his counter after turning your cut aside can be deflected from the first blow", flurrySeen && g.stats.bossDeflects > cd0 && g.stats.hitsTaken === cs0.hitsTaken && g.stats.deflects - cs0.deflects >= 3, `counter string (flurry or combo, after a beat) ${flurrySeen}, deflects +${g.stats.deflects - cs0.deflects}, hits +${g.stats.hitsTaken - cs0.hitsTaken}`);

    // In the air: a tap deflects, a held guard doesn't block.
    const airRun = (how) => {
      fresh(2.4);
      const s0 = { ...g.stats };
      if (how === "hold") inp.press("block", "KeyK");
      g.forceBossAttack("overhead");
      const c = b.attack.hits[0].contact;
      let j = false;
      let t = false;
      let airAtHit = false;
      run(2.2, () => {
        if (!j && b.stateT >= c - 0.3) {
          j = true;
          tap("jump");
        }
        if (how === "tap" && !t && b.stateT >= c - 0.08) {
          t = true;
          tap("block");
        }
        if (!airAtHit && (g.stats.deflects > s0.deflects || g.stats.hitsTaken > s0.hitsTaken)) airAtHit = p.airborne;
      });
      inp.release("block", "KeyK");
      return { d: g.stats.deflects - s0.deflects, bl: g.stats.blocks - s0.blocks, h: g.stats.hitsTaken - s0.hitsTaken, airAtHit, y: p.pos.y };
    };
    const airTap = airRun("tap");
    const airHold = airRun("hold");
    check("air: a tapped guard deflects mid-jump, a held one doesn't block; he lands", airTap.d === 1 && airTap.airAtHit && airHold.bl === 0 && airHold.h === 1 && airTap.y === 0 && airHold.y === 0, `tap: deflect ${airTap.d} (airborne ${airTap.airAtHit}); held: block ${airHold.bl} hit ${airHold.h}; heights after ${airTap.y.toFixed(2)} / ${airHold.y.toFixed(2)}`);

    // Deflects deal more posture than blocks; consecutive deflects more still.
    fresh(2.4);
    b.posture = 0;
    const dCombo = deflectRun("combo", [-0.08]);
    const postDefl = b.posture + 0;
    fresh(2.4);
    b.posture = 0;
    inp.press("block", "KeyK");
    g.forceBossAttack("combo");
    run(2.4);
    inp.release("block", "KeyK");
    const postBlock = b.posture;
    check("deflect: more posture than a block, rising through a string", dCombo.d === 3 && postDefl > R.DEFLECT_POSTURE * 3 && postBlock < 15 && R.deflectPosture({}, 2) > R.deflectPosture({}, 0), `3 deflects -> ${postDefl.toFixed(1)} posture; 3 blocks -> ${postBlock.toFixed(1)}; chain ${R.deflectPosture({}, 0)} -> ${R.deflectPosture({}, 2).toFixed(1)}`);

    // Mikiri: step into the thrust (forward or neutral while locked) during the dodge.
    const mk = (axis, lead) => {
      fresh(3.4);
      const s0 = { ...g.stats };
      g.forceBossAttack("thrust");
      const c = b.attack.hits[0].contact;
      const p0 = b.posture;
      let pr = false;
      let mState = "";
      run(1.6, () => {
        if (!pr && b.stateT >= c - lead) {
          pr = true;
          inp.botAxis = axis;
          tap("dodge");
        }
        if (b.state === "mikiried") mState = "mikiried";
      });
      inp.botAxis = null;
      return { m: g.stats.mikiri - s0.mikiri, h: g.stats.hitsTaken - s0.hitsTaken, post: b.posture - p0, bs: mState || b.state };
    };
    const mkF = mk({ x: 0, y: 1 }, 0.2);
    const mkN = mk(null, 0.15);
    const mkEarly = mk({ x: 0, y: 1 }, 0.85);
    check("mikiri: stepping into the thrust stomps the blade (big posture); too early fails", mkF.m === 1 && mkF.h === 0 && mkF.post >= R.MIKIRI_POSTURE - 1 && mkF.bs === "mikiried" && mkN.m === 1 && mkEarly.m === 0 && mkEarly.h === 1, `forward: mikiri ${mkF.m}, hits ${mkF.h}, posture +${mkF.post.toFixed(0)}, boss ${mkF.bs}; neutral locked: mikiri ${mkN.m}; at the glyph: mikiri ${mkEarly.m}, hits ${mkEarly.h}`);

    // Sweep: standing or side-stepping is cut; a jump clears it; jumping again at him kicks off his head.
    const sw = (how) => {
      fresh(2.2);
      const s0 = { ...g.stats };
      g.forceBossAttack("sweep");
      const c = b.attack.hits[0].contact;
      const p0 = b.posture;
      let pr = false;
      let kicked = false;
      let seen = "";
      let atKick = -1;
      run(2.2, () => {
        if (!pr && b.stateT >= c - (how === "dodge" ? 0.15 : 0.3)) {
          pr = true;
          if (how === "jump" || how === "kick") tap("jump");
          if (how === "dodge") {
            inp.botAxis = { x: 1, y: 0 };
            tap("dodge");
          }
        }
        if (how === "kick" && pr && !kicked && p.state === "jump" && p.stateT > 0.1) {
          kicked = true;
          tap("jump");
        }
        if (b.state === "kicked" && !seen) {
          seen = "kicked";
          atKick = b.posture;
        }
      });
      inp.botAxis = null;
      return { h: g.stats.hitsTaken - s0.hitsTaken, j: g.stats.sweepsJumped - s0.sweepsJumped, k: g.stats.headKicks - s0.headKicks, post: (atKick >= 0 ? atKick : b.posture) - p0, bs: seen };
    };
    const swStand = sw("stand");
    const swDodge = sw("dodge");
    const swJump = sw("jump");
    const swKick = sw("kick");
    check("sweep: can't be guarded; a jump clears it (so do step-dodge i-frames)", swStand.h === 1 && swDodge.h === 0 && swJump.h === 0 && swJump.j === 1, `standing hit ${swStand.h}; step dodge hit ${swDodge.h}; jump hit ${swJump.h} cleared ${swJump.j}`);
    check("sweep: jumping again at him kicks off his head (heavy posture)", swKick.k === 1 && swKick.h === 0 && swKick.post >= R.KICK_HEAD_POSTURE - 1 && swKick.bs === "kicked", `head kicks ${swKick.k}, hits ${swKick.h}, posture +${swKick.post.toFixed(0)}, boss ${swKick.bs}`);

    // Grab: a raised guard doesn't stop it; a dodge or a jump does, and a miss leaves him open.
    const gr = (how) => {
      fresh(2.0);
      const s0 = { ...g.stats };
      const hp0 = p.health;
      if (how === "guard") inp.press("block", "KeyK");
      g.forceBossAttack("grab");
      const c = b.attack.hits[0].contact;
      let pr = false;
      let whiff = false;
      run(2.6, () => {
        if (!pr && b.stateT >= c - 0.26) {
          pr = true;
          if (how === "dodge") {
            inp.botAxis = { x: 1, y: 0 };
            tap("dodge");
          }
          if (how === "jump") tap("jump");
        }
        if (b.state === "whiff") whiff = true;
      });
      inp.release("block", "KeyK");
      inp.botAxis = null;
      return { grabbed: g.stats.grabbed - s0.grabbed, dmg: hp0 - p.health, whiff };
    };
    const grG = gr("guard");
    const grD = gr("dodge");
    const grJ = gr("jump");
    check("grab: goes through guard and throws; a dodge or jump evades and he is left open", grG.grabbed === 1 && grG.dmg >= 30 * R.DIFFICULTY.playerDamage - 0.5 && grD.grabbed === 0 && grD.whiff && grJ.grabbed === 0, `guarding: grabbed ${grG.grabbed}, -${grG.dmg.toFixed(0)} hp; dodge: grabbed ${grD.grabbed}, whiff ${grD.whiff}; jump: grabbed ${grJ.grabbed}`);

    // Perilous glyph shows for all three (at the start of the attack, >= 0.6 s before contact).
    const glyphLead = {};
    for (const atk of ["thrust", "sweep", "grab"]) {
      fresh(3);
      g.fx.glyph.hide();
      g.forceBossAttack(atk);
      run(1 / 60);
      glyphLead[atk] = g.fx.glyph.active ? b.attack.hits[0].contact - b.stateT : -1;
    }
    check("peril: the red glyph flashes for thrust, sweep and grab well before the blow", Object.values(glyphLead).every((v) => v >= 0.6), Object.entries(glyphLead).map(([k, v]) => `${k} ${v.toFixed(2)} s ahead`).join(", "));

    // Gourd: R drinks, heals 45% over a moment after the sip, uses a charge; empty = no heal.
    fresh(5);
    p.health = 40;
    tap("heal");
    run(0.3);
    const midHp = p.health;
    run(1.0);
    const healed = p.health;
    const charges = p.gourd;
    p.gourd = 0;
    p.health = 40;
    run(0.1);
    tap("heal");
    run(1.2);
    check("gourd: R heals ~45% after the sip, costs a charge; no charges, no heal", midHp === 40 && Math.abs(healed - 85) < 0.5 && charges === 2 && p.health === 40 && p.state === "move", `before sip ${midHp}, after ${healed.toFixed(1)}, charges ${charges}; empty -> hp ${p.health}, state ${p.state}`);

    // He punishes the gourd; getting hit before the sip loses the heal.
    fresh(3.2);
    b.passive = false;
    b.cooldown = 99;
    p.health = 50;
    const pun0 = g.stats.punishes;
    tap("heal");
    run(R.DIFFICULTY.healReact + 0.15);
    const punished = g.stats.punishes - pun0;
    const atk = b.attack?.name;
    run(1.8);
    // Point blank he answers at once from the top of his combo: the swallow gets in first (the
    // punish is avoidable by stepping away after it), standing there still gets cut.
    fresh(1.8);
    b.passive = false;
    b.cooldown = 99;
    p.health = 50;
    const hitsPB = g.stats.hitsTaken;
    tap("heal");
    run(1.2);
    const pb = { hit: g.stats.hitsTaken - hitsPB, hp: p.health, gourd: p.gourd };
    check("gourd: he punishes a heal (from range after a beat; point blank at once, avoidable after the swallow)", punished === 1 && !!atk && p.health < 50 + 45 && pb.hit >= 1 && pb.gourd === 2, `range: punish ${punished} with ${atk}; point blank: hits ${pb.hit}, hp ${pb.hp.toFixed(0)}, gourd ${pb.gourd}`);

    // Resurrection doesn't refill the gourd; one resurrection per fight.
    check("gourd: not refilled by resurrection (wiki: only resting refills)", R.GOURD.charges === 3 && R.REZ.charges === 1, `charges ${R.GOURD.charges}, resurrections ${R.REZ.charges}`);

    // Two markers: break -> short deathblow -> he rises, full vitality, posture 0, phase 2; break -> finisher -> victory.
    fresh(2.2);
    b.health = 40;
    b.posture = 95;
    g.forceBossAttack("overhead");
    run(2.2, () => {
      if (b.state === "attack" && b.stateT >= b.attack.hits[0].contact - 0.08 && !g.bot.x) {
        g.bot.x = 1;
        tap("block");
      }
      if (b.state === "stagger") return false;
    });
    g.bot.x = 0;
    const broke = b.state;
    tap("attack");
    run(0.1);
    const db = g.state;
    let rose = false;
    run(6, () => {
      if (b.state === "rise") rose = true;
      if (rose && b.state === "idle") return false;
    });
    const p2 = { st: g.state, bs: b.state, ph: b.phase, m: b.markers, hp: b.health, post: b.posture };
    b.posture = 99;
    b.passive = true;
    b.stagger();
    g.place(2);
    tap("attack");
    run(0.1);
    const fin = g.state;
    run(6, () => g.state !== "victory");
    check("markers: 1st deathblow -> he rises at full vitality in phase 2; 2nd = finisher -> victory", broke === "stagger" && db === "deathblow" && rose && p2.st === "fight" && p2.ph === 2 && p2.m === 1 && p2.hp === 100 && p2.post < 1 && fin === "finisher" && g.state === "victory" && b.markers === 0, `break ${broke} -> ${db}; rose ${rose}: phase ${p2.ph}, markers ${p2.m}, hp ${p2.hp}, posture ${p2.post.toFixed(1)}; then ${fin} -> ${g.state}, markers ${b.markers}`);

    // Vitality to zero also opens a deathblow; missed, he recovers a sliver and fights on.
    fresh(1.6);
    b.health = 3;
    b.state = "recoil";
    b.stateT = 0.1;
    tap("attack");
    run(0.5);
    const vk = b.state;
    const kind = b.breakKind;
    run(4.5);
    check("vitality: zero vitality opens a deathblow; missed, he recovers and fights on", vk === "stagger" && kind === "vitality" && b.health >= 15 && b.state !== "stagger", `at 0 hp -> ${vk} (${kind}); after the window: ${b.state}, hp ${b.health}`);

    // Posture regen by vitality (100/66/33/1 %), both fighters; guard speeds the player's.
    const regenAt = (hp, who, guard) => {
      fresh(4);
      const f = who === "b" ? b : p;
      f.health = hp;
      f.posture = 60;
      f.postureIdle = 5;
      if (guard) inp.press("block", "KeyK");
      run(0.5);
      inp.release("block", "KeyK");
      return 60 - f.posture;
    };
    const bFull = regenAt(100, "b");
    const bLow = regenAt(40, "b");
    const bCrit = regenAt(20, "b");
    const pIdle = regenAt(100, "p");
    const pGuard = regenAt(100, "p", true);
    const pLow = regenAt(60, "p");
    check("posture regen: slower as vitality drops (both), faster behind a raised guard", Math.abs(bLow / bFull - 0.33) < 0.03 && bCrit / bFull < 0.02 && pGuard > pIdle * 2 && Math.abs(pLow / pIdle - 0.66) < 0.03, `boss 0.5 s: full ${bFull.toFixed(2)}, 40% ${bLow.toFixed(2)}, 20% ${bCrit.toFixed(3)}; player idle ${pIdle.toFixed(2)}, guarding ${pGuard.toFixed(2)}, 60% vit ${pLow.toFixed(2)}`);

    // Cancels: guard / dodge / jump cancel a swing's recovery once the cut is over, not before.
    const cancel = (a, at) => {
      fresh(4);
      tap("attack");
      let fired = -1;
      let pressed = false;
      run(0.9, (i) => {
        if (!pressed && p.state === "attack" && p.stateT >= at) {
          pressed = true;
          tap(a);
        }
        const want = a === "block" ? "deflect" : a;
        if (fired < 0 && p.state === want) fired = +(p.stateT + 0).toFixed(3);
      });
      return fired;
    };
    const cBlock = cancel("block", 0.3);
    const cDodge = cancel("dodge", 0.3);
    const cJump = cancel("jump", 0.3);
    const cEarly = cancel("block", 0.05);
    check("cancel: guard / dodge / jump cut a swing's recovery short", cBlock >= 0 && cDodge >= 0 && cJump >= 0, `after the cut: guard ${cBlock >= 0}, dodge ${cDodge >= 0}, jump ${cJump >= 0}; guard pressed in the wind-up ${cEarly >= 0 ? "buffered" : "dropped"}`);

    // He turns aside blade spam and answers with the flurry.
    fresh(1.6);
    b.passive = false;
    b.cooldown = 99;
    const bd0 = g.stats.bossDeflects;
    let answered = "";
    for (let i = 0; i < 8 && !answered; i++) {
      if (b.state === "attack") break;
      tap("attack");
      run(0.4, () => {
        if (b.state === "attack") answered = b.attack.name;
      });
    }
    check("boss: deflects spammed cuts and answers with a string (flurry or combo)", g.stats.bossDeflects - bd0 >= 1 && (answered === "flurry" || answered === "combo"), `deflected ${g.stats.bossDeflects - bd0} cuts, answered with ${answered || "nothing"}`);

    // Charged cut: hold attack; it drives through his guard (vitality chip + posture).
    fresh(1.6);
    b.enter("idle");
    const h0 = b.health;
    const q0 = b.posture;
    inp.press("attack");
    let sawC = false;
    run(1.3, () => {
      if (p.swing?.clip === "attackC") sawC = true;
    });
    inp.release("attack");
    check("attack: holding attack flows into the charged cut, which drives through his guard", sawC && b.health < h0 && b.posture - q0 >= 10, `charged ${sawC}, boss hp ${h0}->${b.health.toFixed(1)}, posture +${(b.posture - q0).toFixed(1)}`);

    // Jump attack: attack in the air cuts down and lands.
    fresh(1.9);
    b.state = "recoil";
    b.stateT = 0;
    tap("jump");
    run(0.12);
    tap("attack");
    const ph0 = g.stats.playerHits;
    let air = false;
    run(1.0, () => {
      if (p.state === "airAttack") air = true;
      b.state = "recoil";
      b.stateT = 0.1;
    });
    check("jump: an air cut comes down on him and lands clean", air && g.stats.playerHits > ph0 && p.state === "move" && p.pos.y === 0, `air cut ${air}, hits +${g.stats.playerHits - ph0}, then ${p.state} at y ${p.pos.y.toFixed(2)}`);

    // Guard break: step dodge or jump shortens it with a safety roll.
    fresh(3);
    p.guardBreak();
    run(0.4);
    tap("dodge");
    run(0.05);
    const roll = p.state;
    check("guard break: a step dodge shortens it (safety roll)", roll === "dodge", `0.4 s into the break + dodge -> ${roll}`);
  }

  // ------------------------------------------------------------ 6. keys and abilities
  {
    const key = (code, up = true) => {
      window.dispatchEvent(new KeyboardEvent("keydown", { code }));
      if (up) window.dispatchEvent(new KeyboardEvent("keyup", { code }));
    };
    const A = p.abil;

    // F = parry: a timed F press deflects his blow; an early one doesn't hold a block up.
    const fProbe = (offMs) => {
      fresh(2.2);
      const s0 = { ...g.stats };
      g.forceBossAttack("overhead");
      const contact = b.attack.hits[0].contact;
      let pressed = false;
      run(2.2, () => {
        if (!pressed && b.state === "attack" && b.stateT >= contact + offMs / 1000) {
          pressed = true;
          key("KeyF");
        }
      });
      return g.stats.deflects > s0.deflects ? "deflect" : g.stats.blocks > s0.blocks ? "block" : g.stats.hitsTaken > s0.hitsTaken ? "hit" : "none";
    };
    const fOn = fProbe(-60);
    const fEarly = fProbe(-600);
    check("keys: F parries (a timed press deflects, an early one is not a held block)", fOn === "deflect" && fEarly === "hit" && !inp.isHeld("block"), `on time: ${fOn}, 0.6 s early: ${fEarly}`);

    // Ctrl does nothing (Ctrl+W closes the tab); 1-2-3 on the title still pick the difficulty.
    fresh(4);
    const st0 = p.state;
    key("ControlLeft");
    key("ControlRight");
    run(0.3);
    check("keys: Ctrl is unbound", p.state === st0 && A.used.curse + A.used.crackers + A.used.crow === 0, `state ${st0} -> ${p.state}`);

    // Each ability: fires once, spends its recharge, refuses while recharging, is ready again on time.
    const cdTest = (id, action, cd, setup) => {
      fresh(setup?.dist ?? 2.4);
      setup?.before?.();
      tap(action);
      run(1.0);
      const fired = A.used[id] === 1;
      const left = A.cd[id];
      // Pressed again while recharging: no second use, and the press is refused visibly.
      const st = p.state;
      tap(action);
      run(0.6);
      const refused = A.used[id] === 1 && p.state !== "tool" && p.state !== "crow";
      run(cd - 1.6 - 0.5);
      const notYet = !A.ready(id);
      run(0.7);
      const ready = A.ready(id) && Math.abs(A.charge(id) - 1) < 1e-6;
      check(`ability ${action.slice(-1)} (${id}): ${cd} s recharge, refused while recharging`, fired && left > cd - 1.05 && refused && notYet && ready, `fired ${fired}, ${left.toFixed(2)} s left after 1 s, refused ${refused} (state ${st}), not ready at ${cd - 0.5} s ${notYet}, ready at ${cd + 0.2} s ${ready}`);
    };

    // 1: Cursed Blade — 9 s, much more damage and posture on each cut.
    fresh(1.5);
    b.state = "recoil";
    b.stateT = 0;
    let h0 = b.health, q0 = b.posture;
    tap("attack");
    run(0.6);
    const plainD = h0 - b.health, plainP = b.posture - q0;
    fresh(1.5);
    tap("ability1");
    run(0.8);
    const lit = A.cursed;
    const tLeft = A.curseT;
    g.place(1.5);
    run(0.05);
    b.state = "recoil";
    b.stateT = 0;
    h0 = b.health;
    q0 = b.posture;
    tap("attack");
    run(0.6);
    const curD = h0 - b.health, curP = b.posture - q0;
    run(9);
    check("ability 1: cursed blade burns ~9 s, cuts deal 1.4x damage and 1.5x posture", lit && tLeft > 8.2 && tLeft <= 9 && !A.cursed && curD > plainD * 1.3 && curP > plainP * 1.4, `burning ${lit} (${tLeft.toFixed(2)} s left), cut ${plainD.toFixed(1)} -> ${curD.toFixed(1)} hp, posture ${plainP.toFixed(1)} -> ${curP.toFixed(1)}, out after 9 s ${!A.cursed}`);
    cdTest("curse", "ability1", 30);

    // 2: Firecrackers — he reels (stunned) if close and in front; not from across the roof.
    fresh(2.6);
    tap("ability2");
    let stunned = false;
    run(1.2, () => {
      if (b.state === "stunned") stunned = true;
    });
    fresh(8);
    tap("ability2");
    let farStun = false;
    run(1.2, () => {
      if (b.state === "stunned") farStun = true;
    });
    check("ability 2: firecrackers stun him up close, not from 8 m", stunned && !farStun && A.used.crackers === 1, `close: stunned ${stunned}; 8 m: stunned ${farStun}`);
    // A stun mid-wind-up cancels his blow.
    fresh(2.4);
    g.forceBossAttack("overhead");
    run(0.1);
    const ht0 = g.stats.hitsTaken;
    tap("ability2");
    run(2.0);
    check("ability 2: firecrackers break his wind-up (the blow never lands)", g.stats.hitsTaken === ht0, `hits taken +${g.stats.hitsTaken - ht0}`);
    cdTest("crackers", "ability2", 20, { dist: 2.6 });

    // 3: Crow Step — she vanishes, reappears behind him, untouchable in between; a cut lands on his back.
    fresh(2.6);
    tap("ability3");
    let hidden = false, inv = false;
    run(0.3, () => {
      if (p.state === "crow" && !p.ch.rig.root.visible) hidden = true;
      if (p.state === "crow" && p.invulnerable) inv = true;
    });
    run(0.25);
    const fx = Math.sin(b.yaw), fz = Math.cos(b.yaw);
    const behind = (p.pos.x - b.pos.x) * fx + (p.pos.z - b.pos.z) * fz < 0;
    const bs = b.state;
    const ph0 = g.stats.playerHits;
    tap("attack");
    run(0.6);
    check("ability 3: crow step vanishes her (untouchable) and puts her behind him for a free cut", hidden && inv && behind && bs === "stunned" && g.stats.playerHits > ph0, `vanished ${hidden}, invulnerable ${inv}, behind him ${behind}, boss ${bs}, back cut ${g.stats.playerHits > ph0}`);
    cdTest("crow", "ability3", 15, { dist: 2.6 });

    // Abilities are fight-only: on the title, 1-2-3 pick the difficulty and cast nothing.
    g.toTitle?.();
    run(0.2);
    if (g.state === "title") {
      const d0 = g.difficulty;
      key("Digit3");
      run(0.1);
      const d3 = g.difficulty;
      key("Digit1");
      run(0.1);
      check("keys: 1-2-3 on the title pick the difficulty, cast nothing", d3 === "hard" && g.difficulty === "easy" && A.used.curse + A.used.crow === 0, `${d0} -> 3: ${d3} -> 1: ${g.difficulty}`);
      key("Digit2");
    }
  }

  g.resume();
  return out;
});

let fails = 0;
for (const r of results) {
  if (!r.ok) fails++;
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}  —  ${r.detail}`);
}
await browser.close();
if (errors.length) {
  console.log("ERRORS:\n" + errors.join("\n"));
  fails++;
}
console.log(fails ? `${fails} FAILED` : "ALL PASS");
process.exit(fails ? 1 : 0);
