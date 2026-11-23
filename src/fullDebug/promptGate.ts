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
