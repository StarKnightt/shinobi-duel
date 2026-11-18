/**
 * The shinobi's three abilities (keys 1, 2, 3 in the fight; on the title 1-3 still pick the
 * difficulty). Cooldowns and the curse timer run on gameplay time, so hit-stop and slow-mo hold
 * them like everything else.
 *
 * Balance: none of them replaces the deflect. The curse only multiplies cuts that land (his guard
 * and his deflect still turn them aside), the firecrackers open him for about a second (fewer cuts
 * in phase 2), and the crow step buys one short opening at his back. Each has a long recharge.
 */
export type AbilityId = "curse" | "crackers" | "crow";

export const ABILITY_IDS: readonly AbilityId[] = ["curse", "crackers", "crow"];

export const ABILITY = {
  /** 1: purple fire wraps the blade. */
  curse: { cooldown: 30, duration: 9, dmg: 1.4, posture: 1.5, cast: 0.42, ignite: 0.16 },
  /** 2: a fistful of firecrackers; he reels if he's in front of her and close. */
  crackers: { cooldown: 20, cast: 0.45, fire: 0.12, range: 4.8, arc: 1.25, stun: [0.85, 0.6] as const },
  /** 3: into the feathers, out behind him; he turns to find her. */
  crow: { cooldown: 15, vanish: 0.16, appear: 0.34, end: 0.46, behind: 1.15, window: 0.75, turn: 2.4 },
} as const;

export class Abilities {
  /** Seconds left on each recharge (0 = ready). */
  readonly cd: Record<AbilityId, number> = { curse: 0, crackers: 0, crow: 0 };
  /** Seconds of cursed blade left. */
  curseT = 0;
  /** Uses this fight (tests). */
  readonly used: Record<AbilityId, number> = { curse: 0, crackers: 0, crow: 0 };

  reset(): void {
    for (const id of ABILITY_IDS) {
      this.cd[id] = 0;
      this.used[id] = 0;
    }
    this.curseT = 0;
  }

  tick(dt: number): void {
    for (const id of ABILITY_IDS) this.cd[id] = Math.max(0, this.cd[id] - dt);
    this.curseT = Math.max(0, this.curseT - dt);
  }

  ready(id: AbilityId): boolean {
    return this.cd[id] <= 0;
  }

  /** Recharge fraction 0..1 (1 = ready) for the HUD. */
  charge(id: AbilityId): number {
    return 1 - this.cd[id] / ABILITY[id].cooldown;
  }

  spend(id: AbilityId): void {
    this.cd[id] = ABILITY[id].cooldown;
    this.used[id]++;
  }

  get cursed(): boolean {
    return this.curseT > 0;
  }
}
