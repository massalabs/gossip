/**
 * When the error pop-up may show: at most once a minute, never while it is
 * open, never again in this session after "Don't ask again", and never from
 * inside its own handling (an error raised by the pop-up must not raise it).
 */
export class PromptGate {
  private last = Number.NEGATIVE_INFINITY;
  private isOpen = false;
  private disabled = false;
  private deciding = false;

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly intervalMs = 60_000
  ) {}

  /** True when the pop-up should open now; it then counts as open. */
  request(): boolean {
    if (this.deciding || this.disabled || this.isOpen) return false;
    this.deciding = true;
    try {
      const t = this.now();
      if (t - this.last < this.intervalMs) return false;
      this.last = t;
      this.isOpen = true;
      return true;
    } finally {
      this.deciding = false;
    }
  }

  get open(): boolean {
    return this.isOpen;
  }

  /** The pop-up closed; `never` stops it for the rest of this session. */
  close(never = false): void {
    this.isOpen = false;
    if (never) this.disabled = true;
  }
}

interface Observed {
  src?: string;
  ev?: string;
  f?: unknown;
}

interface Held {
  kind: 'prelock' | 'lock';
  prompt: () => void;
  suppressed: () => void;
  timer: unknown;
}

/**
 * Errors while the storage is closed for a re-login (end of onboarding: the
 * groups close, `storage.lock`, UI code briefly queries the closed database,
 * `storage.unlock`) do not open the pop-up. Suppressed: an error up to
 * `lookBackMs` before a `storage.lock` (the groups close just before it, so
 * every error first waits that long), between a lock and the next successful
 * `storage.unlock` / `storage.open`, and up to `graceMs` after it. The app's
 * own bug stays in the record; only the pop-up is spared, and `suppressed`
 * is called so that the record says so. A lock that no unlock ends within
 * `maxLockMs` is a login that never completed: it prompts after all.
 */
export class StorageLockWindow {
  private lockedAt: number | null = null;
  private unlockedAt = Number.NEGATIVE_INFINITY;
  private held: Held | null = null;

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly setTimer: (fn: () => void, ms: number) => unknown = (
      fn,
      ms
    ) => setTimeout(fn, ms),
    private readonly clearTimer: (t: unknown) => void = t =>
      clearTimeout(t as ReturnType<typeof setTimeout>),
    private readonly graceMs = 2_000,
    private readonly maxLockMs = 30_000,
    private readonly lookBackMs = 250
  ) {}

  private drop(): void {
    const h = this.held;
    if (!h) return;
    this.held = null;
    this.clearTimer(h.timer);
    h.suppressed();
  }

  private hold(
    kind: Held['kind'],
    prompt: () => void,
    suppressed: () => void,
    ms: number
  ): void {
    const h: Held = { kind, prompt, suppressed, timer: null };
    h.timer = this.setTimer(() => {
      if (this.held !== h) return;
      this.held = null;
      h.prompt();
    }, ms);
    this.held = h;
  }

  /** Every recorded event passes here (before the error listeners). */
  observe(e: Observed): void {
    if (e.src !== 'storage') return;
    if (e.ev === 'storage.lock') {
      this.lockedAt = this.now();
      // An error just before the lock belongs to it.
      if (this.held?.kind === 'prelock') this.drop();
      return;
    }
    const f = (e.f ?? {}) as { ok?: unknown };
    const unlocked =
      (e.ev === 'storage.unlock' && f.ok === true) ||
      (e.ev === 'storage.open' && f.ok !== false);
    if (!unlocked || this.lockedAt === null) {
      if (unlocked) this.unlockedAt = this.now();
      return;
    }
    this.lockedAt = null;
    this.unlockedAt = this.now();
    // The errors held while locked were the expected ones.
    if (this.held?.kind === 'lock') this.drop();
  }

  /**
   * For an error: calls `prompt` (now or a little later) or `suppressed`.
   * At most one error is held at a time: one pop-up is enough.
   */
  check(prompt: () => void, suppressed: () => void): void {
    const t = this.now();
    if (this.lockedAt !== null) {
      const left = this.lockedAt + this.maxLockMs - t;
      if (left <= 0) {
        prompt();
        return;
      }
      if (this.held?.kind === 'lock') {
        suppressed();
        return;
      }
      this.drop();
      this.hold('lock', prompt, suppressed, left);
      return;
    }
    if (t - this.unlockedAt <= this.graceMs) {
      suppressed();
      return;
    }
    if (this.held) return;
    this.hold('prelock', prompt, suppressed, this.lookBackMs);
  }
}
