// Wavedash platform hooks. Every call is a no-op when window.Wavedash is absent
// (GitHub Pages, Vercel, local dev), so the same build runs everywhere.

type LeaderboardResponse = { success: boolean; data?: { id: string } };

type WavedashSdk = {
  init(config?: object): boolean;
  updateLoadProgressZeroToOne(progress: number): void;
  requestStats(): Promise<unknown>;
  getAchievement(id: string): boolean;
  setAchievement(id: string, storeNow?: boolean): boolean;
  getOrCreateLeaderboard(name: string, sortOrder: number, displayType: number): Promise<LeaderboardResponse>;
  uploadLeaderboardScore(id: string, score: number, keepBest: boolean): Promise<unknown>;
};

const sdk = (): WavedashSdk | undefined => (window as unknown as { Wavedash?: WavedashSdk }).Wavedash;

const SORT = { asc: 0, desc: 1 } as const;
const DISPLAY = { numeric: 0, seconds: 1, milliseconds: 2 } as const;

const boards = new Map<string, Promise<string | null>>();
let initialized = false;

function boardId(name: string, sort: keyof typeof SORT, display: keyof typeof DISPLAY): Promise<string | null> {
  let id = boards.get(name);
  if (!id) {
    id = sdk()!
      .getOrCreateLeaderboard(name, SORT[sort], DISPLAY[display])
      .then((r) => (r.success && r.data ? r.data.id : null))
      .catch(() => null);
    boards.set(name, id);
  }
  return id;
}

export const wavedash = {
  get active(): boolean {
    return !!sdk();
  },

  progress(p: number): void {
    try {
      sdk()?.updateLoadProgressZeroToOne(Math.min(1, Math.max(0, p)));
    } catch {}
  },

  ready(): void {
    const s = sdk();
    if (!s || initialized) return;
    initialized = true;
    try {
      s.updateLoadProgressZeroToOne(1);
      s.init({ debug: false });
      void s.requestStats().catch(() => {});
    } catch {}
  },

  /** Stats load asynchronously after init; retry until the unlock sticks. */
  achieve(id: string): void {
    const s = sdk();
    if (!s) return;
    let tries = 0;
    const attempt = () => {
      let ok = false;
      try {
        ok = s.getAchievement(id) || s.setAchievement(id, true);
      } catch {}
      if (!ok && ++tries < 20) setTimeout(attempt, 1500);
    };
    attempt();
  },

  submitScore(
    name: string,
    score: number,
    sort: keyof typeof SORT = "asc",
    display: keyof typeof DISPLAY = "milliseconds",
  ): void {
    if (!sdk()) return;
    void boardId(name, sort, display)
      .then((id) => (id ? sdk()!.uploadLeaderboardScore(id, Math.round(score), true) : null))
      .catch(() => {});
  },
};
