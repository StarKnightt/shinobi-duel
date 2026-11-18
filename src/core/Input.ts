/**
 * Keyboard + mouse. Edge-triggered actions are stamped with the time they were pressed (in
 * gameplay seconds) so the combat code can measure the deflect window exactly, independent
 * of frame rate. An action is held while any of its sources (keys, mouse buttons, the test bot)
 * is down, so a second binding pressed while the first is held is a fresh press.
 *
 * Menus (title, resurrection, defeat, victory) never read gameplay actions: they arm a one-shot
 * prompt that fires once, on a fresh key / button press made after an arming delay; anything
 * already held when the prompt was armed is ignored until released.
 */
import { DIFFICULTY } from "../game/difficulty";

export type Action = "attack" | "block" | "dodge" | "jump" | "lock" | "heal" | "ability1" | "ability2" | "ability3";
export type PromptKey = "confirm" | "back";

/**
 * Keys that never count as "any key": mute (M), the title's difficulty keys (A / D, arrows,
 * 1-3), modifiers, OS / lock keys, function keys.
 */
const NOT_ANY = /^(KeyM|Key[AD]|Arrow(Left|Right)|(Digit|Numpad)[1-3]|Shift(Left|Right)|Control(Left|Right)|Alt(Left|Right)|Meta(Left|Right)|OS(Left|Right)|CapsLock|NumLock|ScrollLock|ContextMenu|Tab|PrintScreen|F\d+)$/;
const MOUSE_ACTION: Record<number, Action | undefined> = { 0: "attack", 1: "lock", 2: "block" };

export class Input {
  readonly keys = new Set<string>();
  mouseDX = 0;
  mouseDY = 0;
  private pressed = new Map<Action, number>();
  private held = new Map<Action, Set<string>>();
  private heldSince = new Map<Action, number>();
  /** Current gameplay clock, set by the game each step; presses are stamped with it. */
  clock = 0;
  /** Real-time clock (seconds), set by the game each frame; prompts are debounced with it. */
  realClock = 0;
  locked = false;
  /** Clicks may take pointer lock (the fight only; menus keep a free cursor). */
  lockable = false;
  private prompt: { keys: "any" | "menu"; at: number; stale: Set<string> } | null = null;
  private promptOut: PromptKey | null = null;
  /** Every fresh key press (menus that need more than a prompt: the title's difficulty choice). */
  onKeyDown: ((code: string) => void) | null = null;

  constructor(private readonly canvas: HTMLCanvasElement) {
    window.addEventListener("keydown", (e) => {
      if (e.code === "Space" || e.code === "Tab") e.preventDefault();
      if (e.repeat) return;
      this.keys.add(e.code);
      this.onKeyDown?.(e.code);
      this.promptPress(e.code);
      const a = this.keyAction(e.code);
      if (a) this.press(a, e.code);
      // F: parry. A guard tap that doesn't stay up: the same deflect window (and the same
      // anti-mash rule) as a right-click press, but no held block behind it.
      if (e.code === "KeyF") {
        this.press("block", "KeyF");
        this.release("block", "KeyF");
      }
    });
    window.addEventListener("keyup", (e) => {
      this.keys.delete(e.code);
      this.prompt?.stale.delete(e.code);
      const a = this.keyAction(e.code);
      if (a) this.release(a, e.code);
    });
    window.addEventListener("blur", () => this.releaseAll());
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    window.addEventListener("mousedown", (e) => {
      if (this.lockable && !this.locked) this.requestLock();
      const src = `Mouse${e.button}`;
      this.keys.add(src);
      this.promptPress(src);
      const a = MOUSE_ACTION[e.button];
      if (a) {
        e.preventDefault();
        this.press(a, src);
      }
    });
    window.addEventListener("mouseup", (e) => {
      const src = `Mouse${e.button}`;
      this.keys.delete(src);
      this.prompt?.stale.delete(src);
      const a = MOUSE_ACTION[e.button];
      if (a) this.release(a, src);
    });
    window.addEventListener("mousemove", (e) => {
      if (document.pointerLockElement === canvas) {
        this.mouseDX += e.movementX;
        this.mouseDY += e.movementY;
      }
    });
    document.addEventListener("pointerlockchange", () => {
      this.locked = document.pointerLockElement === canvas;
    });
  }

  private keyAction(code: string): Action | null {
    switch (code) {
      case "KeyJ":
        return "attack";
      case "KeyK":
      case "KeyL":
        return "block";
      case "ShiftLeft":
      case "ShiftRight":
        return "dodge";
      case "Space":
        return "jump";
      case "KeyQ":
      case "Tab":
        return "lock";
      case "KeyR":
        return "heal";
      // Abilities. Ctrl is deliberately unbound (Ctrl+W closes the tab).
      case "Digit1":
      case "Numpad1":
        return "ability1";
      case "Digit2":
      case "Numpad2":
        return "ability2";
      case "Digit3":
      case "Numpad3":
        return "ability3";
    }
    return null;
  }

  // ------------------------------------------------------------------ prompts

  /**
   * Arm a one-shot prompt. "any": every key / button confirms. "menu": Enter, E, Space or a left
   * click confirm, Escape / Backspace go back; other keys are ignored. Replaces any armed prompt.
   */
  armPrompt(keys: "any" | "menu", delay = 0.5): void {
    this.prompt = { keys, at: this.realClock + delay, stale: new Set(this.keys) };
    this.promptOut = null;
  }

  disarmPrompt(): void {
    this.prompt = null;
    this.promptOut = null;
  }

  get promptArmed(): boolean {
    return !!this.prompt;
  }

  /** The prompt's answer, once (the prompt disarms itself when it fires). */
  takePrompt(): PromptKey | null {
    const r = this.promptOut;
    this.promptOut = null;
    return r;
  }

  /** A press from a key / button (or a test); returns what the prompt made of it. */
  promptPress(code: string): PromptKey | null {
    const p = this.prompt;
    if (!p || this.realClock < p.at || p.stale.has(code)) return null;
    let k: PromptKey | null = null;
    if (code === "Escape" || code === "Backspace") k = "back";
    else if ((p.keys === "any" && !NOT_ANY.test(code)) || code === "Enter" || code === "NumpadEnter" || code === "KeyE" || code === "Space" || code === "Mouse0") k = "confirm";
    if (!k) return null;
    this.prompt = null;
    this.promptOut = k;
    return k;
  }

  // ------------------------------------------------------------------ actions

  /**
   * Anti-mash (the wiki's rule, made forgiving): a guard press soon after the guard was released
   * shrinks the deflect window, one step per such press (DIFFICULTY.deflectSteps: 0.25 → 0.25 →
   * 0.22 → 0.19 → 0.16 s, never below 0.16). The penalty clears once guard has been released for
   * MASH_RESET, and after a successful deflect. Two presses per incoming blow keep the full window.
   */
  static readonly MASH_RESET = 0.5;
  static readonly DEFLECT_STEPS = DIFFICULTY.deflectSteps;
  private mash = 0;
  private guardUp = -1;
  private lastGuardPress = -1;
  /** Deflect window granted to the most recent guard press. */
  deflectWindow = Input.DEFLECT_STEPS[0];

  press(a: Action, src = "bot"): void {
    let set = this.held.get(a);
    if (!set) this.held.set(a, (set = new Set()));
    if (!set.size) {
      if (a === "block") {
        const recent = this.guardUp >= 0 && this.clock - this.guardUp < Input.MASH_RESET;
        this.mash = recent ? Math.min(this.mash + 1, Input.DEFLECT_STEPS.length - 1) : 0;
        this.deflectWindow = Input.DEFLECT_STEPS[this.mash];
      }
      this.heldSince.set(a, this.clock);
    } else if (a === "block") {
      // Another binding tapped while guard is held: one re-tap is a fresh window, but tapping
      // it repeatedly is mashing like any other.
      const recent = this.lastGuardPress >= 0 && this.clock - this.lastGuardPress < Input.MASH_RESET;
      this.mash = recent ? Math.min(this.mash + 1, Input.DEFLECT_STEPS.length - 1) : 0;
      this.deflectWindow = Input.DEFLECT_STEPS[this.mash];
    }
    if (a === "block") this.lastGuardPress = this.clock;
    set.add(src);
    this.pressed.set(a, this.clock);
  }

  release(a: Action, src = "bot"): void {
    const set = this.held.get(a);
    if (!set || !set.has(src)) return;
    set.delete(src);
    if (!set.size && a === "block") this.guardUp = this.clock;
  }

  releaseAll(): void {
    this.keys.clear();
    if (this.isHeld("block")) this.guardUp = this.clock;
    this.held.clear();
  }

  /** Drop every buffered press (a prompt answer or a restart must not leak into the fight). */
  flush(): void {
    this.pressed.clear();
  }

  resetMash(): void {
    this.mash = 0;
    this.guardUp = -1;
    this.lastGuardPress = -1;
    this.deflectWindow = Input.DEFLECT_STEPS[0];
  }

  /** Consume a buffered press if it happened within `buffer` seconds. */
  consume(a: Action, buffer = 0.25): boolean {
    const t = this.pressed.get(a);
    if (t === undefined) return false;
    this.pressed.delete(a);
    return this.clock - t <= buffer;
  }

  peekPressTime(a: Action): number | undefined {
    return this.pressed.get(a);
  }

  isHeld(a: Action): boolean {
    return (this.held.get(a)?.size ?? 0) > 0;
  }

  /** Seconds the action has been held continuously (0 when up). */
  heldFor(a: Action): number {
    return this.isHeld(a) ? this.clock - (this.heldSince.get(a) ?? this.clock) : 0;
  }

  /** Test bot: overrides the movement keys when set. */
  botAxis: { x: number; y: number } | null = null;

  requestLock(): void {
    if (document.pointerLockElement === this.canvas) return;
    try {
      const p = this.canvas.requestPointerLock?.() as unknown as Promise<void> | undefined;
      p?.catch?.(() => {});
    } catch {
      /* pointer lock unavailable (headless, iframe) */
    }
  }

  releaseLock(): void {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  axis(): { x: number; y: number } {
    if (this.botAxis) return this.botAxis;
    let x = 0;
    let y = 0;
    if (this.keys.has("KeyW") || this.keys.has("ArrowUp")) y += 1;
    if (this.keys.has("KeyS") || this.keys.has("ArrowDown")) y -= 1;
    if (this.keys.has("KeyD") || this.keys.has("ArrowRight")) x += 1;
    if (this.keys.has("KeyA") || this.keys.has("ArrowLeft")) x -= 1;
    const l = Math.hypot(x, y);
    if (l > 1) {
      x /= l;
      y /= l;
    }
    return { x, y };
  }

  takeMouse(): { dx: number; dy: number } {
    const r = { dx: this.mouseDX, dy: this.mouseDY };
    this.mouseDX = 0;
    this.mouseDY = 0;
    return r;
  }
}
