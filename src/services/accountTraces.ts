import { Capacitor } from '@capacitor/core';
import type { GossipSdk } from '@massalabs/gossip-sdk';
import { logger } from '../utils/logger.ts';

/**
 * A locked app leaves nothing behind, outside the encrypted store, that
 * belongs to an account.
 *
 * While an account is open, some of its data is published outside the store
 * so the app can notify about new messages: the polling keys ("seekers")
 * read by the service worker (web) or the background runner (native), the
 * time of the last background sync, delivered notifications, and debug logs
 * when they are enabled. Any of these, found by someone who holds the
 * password of one account, can show that another account exists or when it
 * was used. So every lock removes them all, and so does every start of the
 * app (it may have been killed while unlocked).
 *
 * Consequence: no background polling and no notifications while locked.
 */

let pending: Promise<void> = Promise.resolve();

async function clearWebSyncState(): Promise<void> {
  const { bridgeGet, bridgeSetMany } = await import('../sw-bridge');
  const clear = async () => {
    const generation =
      (await bridgeGet<number>('accountOutputGeneration')) ?? 0;
    // A new generation turns away any write already in flight for the old
    // owner (see `withSdkOutputFence`).
    await bridgeSetMany([
      ['accountOutputGeneration', generation + 1],
      ['activeSeekers', []],
      ['lastSyncTimestamp', 0],
    ]);
  };
  if (navigator.locks) {
    await navigator.locks.request(
      'gossip-account-output-v1',
      { mode: 'exclusive' },
      clear
    );
  } else {
    await clear();
  }
}

async function clearAll(): Promise<void> {
  const failures: unknown[] = [];
  const attempt = async (operation: () => Promise<void>) => {
    try {
      await operation();
    } catch (error) {
      failures.push(error);
    }
  };

  const { suspendSdkEventOutputs } = await import('./index');
  const epoch = await suspendSdkEventOutputs();
  const preferences = await import('../utils/preferences');
  if (Capacitor.isNativePlatform()) {
    // Block before clearing, so a background sync that is running cannot
    // write the seekers back.
    await attempt(() => preferences.blockAccountLinkedSyncState(epoch));
  } else {
    await attempt(clearWebSyncState);
  }
  await attempt(preferences.clearAccountLinkedSyncState);
  await attempt(async () => {
    const { notificationService } = await import('./notifications');
    await notificationService.clearAllNotifications();
  });
  // Last, so nothing logged by the steps above survives.
  await attempt(async () => {
    const { clearDebugLogsDurably } = await import('../stores/useDebugLogs');
    await clearDebugLogsDurably();
  });
  if (failures.length > 0) {
    throw new Error(
      `Account traces were not all cleared: ${failures
        .map(failure =>
          failure instanceof Error ? failure.message : String(failure)
        )
        .join('; ')}`
    );
  }
}

/**
 * Remove every account trace kept outside the encrypted store. Call after
 * the session is closed. Never rejects; a failure is retried at the next
 * lock or start.
 */
export function clearAccountTraces(): Promise<void> {
  const run = pending.then(clearAll, clearAll);
  pending = run.catch(error => {
    logger.error('Could not clear account traces:', error);
  });
  return pending;
}

/**
 * Let the account being opened publish outside the store again. Waits for a
 * clearance still running, so it cannot erase what this account publishes.
 */
export async function admitAccountOutputs(sdk: GossipSdk): Promise<void> {
  await pending;
  const { resumeSdkEventOutputs } = await import('./index');
  resumeSdkEventOutputs(sdk);
}
