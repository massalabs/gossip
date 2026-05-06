/**
 * Safari module-worker dedup.
 *
 * Safari sometimes dispatches two responses to the main thread for a single
 * `postMessage` on a `{type:'module'}` worker: an `{type:'error'}` first,
 * then the real `{type:'*-result'}` a few ms later. The SDK settles its
 * pending promise on the first response, so init fails even though the
 * worker is healthy.
 *
 * Wrap `Worker` so error responses are buffered briefly. If a non-error
 * response arrives for the same id within the grace window, the error is
 * dropped and the success is forwarded.
 *
 * On Chrome / native no duplicate is ever emitted, so this is a no-op
 * there.
 *
 * TODO: remove when Safari fixes the Safari 26 module-worker race.
 * Confirmed 2026-04-24 on macOS Safari 26.4 (21624.1.16.11.4): fails
 * identically on `vite preview` over localhost, so it's purely a WebKit
 * 26 regression — not DeWeb, not chunked encoding, not IDB storage
 * state. Related WebKit issues in the same release family: #298616
 * (WebSocket worker instability on iOS 26). A specific bugzilla for
 * this double-dispatch race hasn't been filed yet — consider reporting
 * upstream with a minimal module-worker + postMessage repro.
 *
 * TODO: consider narrowing the buffer to startup-only (e.g. disable
 * after N successful messages) if prod logs confirm the race only
 * fires during SDK init. Current permanent form costs 250ms on genuine
 * SQLite errors on Safari; acceptable as long as those errors stay
 * rare.
 */
const GRACE_MS = 250;

interface WorkerMessage {
  id?: number;
  type?: string;
}

function isSafari(): boolean {
  return /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
}

export function installSafariWorkerDedup(): void {
  if (!isSafari()) return;
  const OrigWorker = window.Worker;

  class PatchedWorker extends OrigWorker {
    constructor(scriptURL: string | URL, options?: WorkerOptions) {
      super(scriptURL, options);

      const pendingErrors = new Map<number, ReturnType<typeof setTimeout>>();
      let sdkHandler: ((e: MessageEvent) => void) | null = null;

      const forward = (e: MessageEvent) => sdkHandler?.call(this, e);

      super.addEventListener('message', (e: MessageEvent) => {
        const { id, type } = (e.data ?? {}) as WorkerMessage;
        if (typeof id !== 'number') {
          forward(e);
          return;
        }
        if (type === 'error') {
          const timer = setTimeout(() => {
            pendingErrors.delete(id);
            forward(e);
          }, GRACE_MS);
          pendingErrors.set(id, timer);
          return;
        }
        const bufferedTimer = pendingErrors.get(id);
        if (bufferedTimer !== undefined) {
          clearTimeout(bufferedTimer);
          pendingErrors.delete(id);
        }
        forward(e);
      });

      Object.defineProperty(this, 'onmessage', {
        configurable: true,
        get: () => sdkHandler,
        set: (h: ((e: MessageEvent) => void) | null) => {
          sdkHandler = h;
        },
      });
    }
  }

  window.Worker = PatchedWorker as typeof Worker;
}
