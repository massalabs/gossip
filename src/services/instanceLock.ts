/**
 * One instance of the web app at a time. Two tabs of one browser profile
 * would each open the account's storage and run their own engines over it:
 * each would overwrite what the other wrote, and use the same session
 * seekers with different ciphertexts, which the server refuses (409).
 *
 * The app holds an exclusive Web Lock for the life of the tab, taken before
 * anything is opened; a tab that does not get it does not start. The
 * browser releases the lock when the tab closes or crashes, and nothing is
 * stored for it. One name for every account: no account is named.
 * Native apps run one instance by construction and take no lock.
 */
export const INSTANCE_LOCK_NAME = 'gossip-app-instance-v1';

export interface InstanceLock {
  state: 'held' | 'elsewhere';
  /** Lets another tab start (the app is closing). */
  release(): void;
}

export async function holdInstanceLock(
  locks: LockManager | undefined = globalThis.navigator?.locks
): Promise<InstanceLock> {
  if (!locks) return { state: 'held', release: () => {} };
  let release!: () => void;
  const released = new Promise<void>(resolve => {
    release = resolve;
  });
  return new Promise<InstanceLock>((resolve, reject) => {
    locks
      .request(
        INSTANCE_LOCK_NAME,
        { mode: 'exclusive', ifAvailable: true },
        async lock => {
          if (!lock) {
            resolve({ state: 'elsewhere', release: () => {} });
            return;
          }
          resolve({ state: 'held', release });
          // Held until the tab goes, or `release`.
          await released;
        }
      )
      .catch(reject);
  });
}

/**
 * Starts the app if no other tab runs it, otherwise shows `elsewhere`
 * without starting anything.
 */
export async function runSingleInstance(
  start: () => Promise<void>,
  elsewhere: () => void,
  locks: LockManager | undefined = globalThis.navigator?.locks
): Promise<void> {
  const instance = await holdInstanceLock(locks);
  if (instance.state === 'elsewhere') {
    elsewhere();
    return;
  }
  await start();
}
