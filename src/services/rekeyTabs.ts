/**
 * Keeps other windows of the app out of storage while one of them rekeys it.
 *
 * Each window (browser tab, PWA window) has its own copy of the secure store
 * in memory. A rekey reads the store once and replaces it whole, so anything
 * another window writes in the meantime would be lost, and a window that is
 * still open on the old generation could be unlocked with a password that
 * no longer exists. So:
 *
 * - A window holds a shared Web Lock while an account is open in it.
 * - The rekeying window holds an exclusive rekey lock for the whole
 *   operation and announces it. Other windows log out (which flushes what
 *   they wrote), release their shared lock, show a blocking screen, and
 *   reload once the rekey lock is released.
 * - The rekeying window starts touching storage only once it has the
 *   session lock exclusively, i.e. once every other window has logged out.
 * - A window opened while a rekey runs gets no announcement; it finds the
 *   rekey lock held instead.
 *
 * Without Web Locks (very old browsers) all of this is skipped and the
 * previous behaviour applies: other windows learn about the new generation
 * when they next write, and must reload.
 */

const REKEY_LOCK = 'gossip-secure-storage-rekey-v1';
const SESSION_LOCK = 'gossip-secure-storage-session-v1';
const CHANNEL_NAME = 'gossip-secure-storage-rekey-v1';
const START = 'rekey-start';

/** How long the rekeying window waits for the others to log out. */
export const OTHER_WINDOWS_TIMEOUT_MS = 15_000;

// One channel per window: a BroadcastChannel never delivers to itself, so
// the rekeying window does not react to its own announcement.
const channel =
  typeof BroadcastChannel !== 'undefined'
    ? new BroadcastChannel(CHANNEL_NAME)
    : null;

function lockManager(): LockManager | undefined {
  return typeof navigator !== 'undefined' ? navigator.locks : undefined;
}

/**
 * Acquire a lock and keep it until the returned function is called.
 * Resolves `null` when `ifAvailable` is set and the lock is taken.
 */
async function hold(
  locks: LockManager,
  name: string,
  options: LockOptions
): Promise<(() => void) | null> {
  let release!: () => void;
  const held = new Promise<void>(resolve => {
    release = resolve;
  });
  return new Promise((resolve, reject) => {
    locks
      .request(name, options, async lock => {
        if (!lock) {
          resolve(null);
          return;
        }
        resolve(release);
        await held;
      })
      .catch(reject);
  });
}

/** Called while an account is open in this window. Returns the release. */
export function holdSessionPresence(): () => void {
  const locks = lockManager();
  if (!locks) return () => {};
  const controller = new AbortController();
  let release: (() => void) | null = null;
  let done = false;
  void hold(locks, SESSION_LOCK, {
    mode: 'shared',
    signal: controller.signal,
  }).then(
    acquired => {
      if (done) acquired?.();
      else release = acquired;
    },
    () => {}
  );
  return () => {
    done = true;
    controller.abort();
    release?.();
  };
}

/** Another window is already rekeying. Nothing was started. */
export class RekeyElsewhereError extends Error {
  constructor() {
    super('Another window is already re-encrypting storage');
    this.name = 'RekeyElsewhereError';
  }
}

/**
 * Become the only window allowed to rekey, and tell the others to log out.
 * Returns the release.
 */
export async function claimRekey(): Promise<() => void> {
  const locks = lockManager();
  if (!locks) return () => {};
  const release = await hold(locks, REKEY_LOCK, {
    mode: 'exclusive',
    ifAvailable: true,
  });
  if (!release) throw new RekeyElsewhereError();
  channel?.postMessage(START);
  return release;
}

/**
 * Wait until no other window has an account open, then keep it that way
 * until the returned function is called. Call after this window has logged
 * out. Rejects after `timeoutMs` if some window does not let go.
 */
export async function waitForOtherWindows(
  timeoutMs = OTHER_WINDOWS_TIMEOUT_MS
): Promise<() => void> {
  const locks = lockManager();
  if (!locks) return () => {};
  const release = await hold(locks, SESSION_LOCK, {
    mode: 'exclusive',
    signal: AbortSignal.timeout(timeoutMs),
  });
  return release ?? (() => {});
}

/**
 * Call `onRekey` when another window starts a rekey, or right away if one is
 * already running. Returns the unsubscribe.
 */
export function watchRekeyElsewhere(onRekey: () => void): () => void {
  const listener = (event: MessageEvent) => {
    if (event.data === START) onRekey();
  };
  channel?.addEventListener('message', listener);
  void lockManager()
    ?.query()
    .then(
      snapshot => {
        if (snapshot.held?.some(lock => lock.name === REKEY_LOCK)) onRekey();
      },
      () => {}
    );
  return () => channel?.removeEventListener('message', listener);
}

/** Resolve once no window holds the rekey lock. */
export async function waitForRekeyEnd(): Promise<void> {
  const locks = lockManager();
  if (!locks) return;
  await locks.request(REKEY_LOCK, { mode: 'shared' }, async () => {});
}
