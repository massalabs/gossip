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

/** What the storage-lock window decided for one error. */
export type LockVerdict = 'prompt' | 'suppressed' | 'deferred';

interface Observed {
  src?: string;
  ev?: string;
  f?: unknown;
}

/**
 * Errors while the storage is closed for a re-login (end of onboarding:
 * `storage.lock`, then UI code briefly queries the closed database, then
 * `storage.unlock`) do not open the pop-up: an error between a lock and the
 * next successful `storage.unlock` / `storage.open`, or up to `graceMs`
 * after it, is suppressed. The app's own bug stays in the record; only the
 * pop-up is spared. A lock that no unlock ends within `maxLockMs` is a login
 * that never completed: its errors then prompt after all.
 */
export class StorageLockWindow {
  private lockedAt: number | null = null;
  private unlockedAt = Number.NEGATIVE_INFINITY;
  private deferred: (() => void) | null = null;
  private timer: unknown = null;

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly setTimer: (fn: () => void, ms: number) => unknown = (
      fn,
      ms
    ) => setTimeout(fn, ms),
    private readonly clearTimer: (t: unknown) => void = t =>
      clearTimeout(t as ReturnType<typeof setTimeout>),
    private readonly graceMs = 2_000,
    private readonly maxLockMs = 30_000
  ) {}

  /** Every recorded event passes here (before the error listeners). */
  observe(e: Observed): void {
    if (e.src !== 'storage') return;
    if (e.ev === 'storage.lock') {
      this.lockedAt = this.now();
      return;
    }
    const f = (e.f ?? {}) as { ok?: unknown };
    const unlocked =
      (e.ev === 'storage.unlock' && f.ok === true) ||
      (e.ev === 'storage.open' && f.ok !== false);
    if (!unlocked) return;
    this.lockedAt = null;
    this.unlockedAt = this.now();
    // The errors held while locked are the expected ones: dropped.
    this.deferred = null;
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }

  /**
   * For an error: `prompt` now, `suppressed`, or `deferred` (locked: `prompt`
   * runs if no unlock comes within `maxLockMs` of the lock).
   */
  check(prompt: () => void): LockVerdict {
    const t = this.now();
    if (this.lockedAt !== null) {
      const left = this.lockedAt + this.maxLockMs - t;
      if (left <= 0) return 'prompt';
      if (this.deferred === null) {
        this.deferred = prompt;
        this.timer = this.setTimer(() => {
          this.timer = null;
          const p = this.deferred;
          this.deferred = null;
          p?.();
        }, left);
      }
      return 'deferred';
    }
    if (t - this.unlockedAt <= this.graceMs) return 'suppressed';
    return 'prompt';
  }
}
