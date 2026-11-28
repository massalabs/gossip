/**
 * Settings that only exist to deliver notifications follow the top
 * "Notifications" switch.
 *
 * - The background runner (`public/runners/background-sync.js`, Android and
 *   iOS) and the web service worker fetch messages only to count them and show
 *   a notification: they store nothing. With notifications off they would
 *   send requests for nothing, so they read a flag and skip the fetch.
 * - "Keep sync active" (Android `GossipForegroundSyncService`) only wakes the
 *   runner on a timer, so it stops with notifications off and starts again
 *   when they come back, if the user had chosen it. The user's choice is kept
 *   in its own preference so turning notifications off never loses it.
 *
 * Not governed, on purpose: the offline mesh (`MeshService`) has its own
 * foreground service to relay messages for other phones, and the battery
 * optimisation exemption and background activity are system settings the
 * mesh also needs. Turning notifications off must not stop them.
 */

import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { ForegroundSync } from './foregroundSync';
import { backgroundRunnerStorageService } from './backgroundRunnerStorage';
import { notificationService } from './notifications';
import { bridgeSet } from '../sw-bridge';
import { dlog } from '@massalabs/gossip-sdk/utils/debugLog.js';

/** KV key read by `public/runners/background-sync.js` — keep in sync. */
export const NOTIFICATIONS_ENABLED_RUNNER_KEY = 'gossip-notifications-enabled';
/** Bridge key read by `src/sw.ts` — keep in sync. */
export const NOTIFICATIONS_ENABLED_BRIDGE_KEY = 'notificationsEnabled';
/** The user's own "Keep sync active" choice, kept while notifications are off. */
export const KEEP_SYNC_CHOICE_KEY = 'gossip-keep-sync-active-choice';

function isAndroid(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
}

// Toggles can come faster than the native calls finish: run them in order so
// the last switch position always wins.
let tail: Promise<unknown> = Promise.resolve();
function serial<T>(task: () => Promise<T>): Promise<T> {
  const run = tail.then(task, task);
  tail = run.catch(() => undefined);
  return run;
}

async function serviceFlag(): Promise<boolean> {
  try {
    return (await ForegroundSync.isEnabled()).enabled;
  } catch {
    return false;
  }
}

async function readKeepSyncChoice(): Promise<boolean> {
  const { value } = await Preferences.get({ key: KEEP_SYNC_CHOICE_KEY });
  if (value === 'true' || value === 'false') return value === 'true';
  // First run with this preference: the service flag is the user's choice.
  const enabled = await serviceFlag();
  await Preferences.set({ key: KEEP_SYNC_CHOICE_KEY, value: String(enabled) });
  return enabled;
}

/** Start or stop the service so it runs only when both are on. */
async function applyKeepSync(notificationsOn: boolean): Promise<void> {
  // Read the choice before any stop, so a first read records the real state.
  // Not `notificationsOn && read()`: the read must happen in both cases.
  const choice = await readKeepSyncChoice();
  const want = notificationsOn && choice;
  const running = await serviceFlag();
  dlog('app', 'sync.keep_sync', {
    notifications: notificationsOn,
    choice,
    running,
    action: want === running ? 'none' : want ? 'start' : 'stop',
  });
  if (want && !running) await ForegroundSync.start();
  if (!want && running) await ForegroundSync.stop();
}

async function applyUnlocked(notificationsOn: boolean): Promise<void> {
  dlog('app', 'sync.notifications_dependents', {
    notifications: notificationsOn,
  });
  if (Capacitor.isNativePlatform()) {
    await backgroundRunnerStorageService.set(
      NOTIFICATIONS_ENABLED_RUNNER_KEY,
      String(notificationsOn)
    );
  } else {
    try {
      await bridgeSet(NOTIFICATIONS_ENABLED_BRIDGE_KEY, notificationsOn);
    } catch {
      // No IndexedDB: the service worker keeps its previous behaviour.
    }
  }
  if (isAndroid()) await applyKeepSync(notificationsOn);
}

/** The user's "Keep sync active" choice, whatever the notifications state. */
export function getKeepSyncChoice(): Promise<boolean> {
  if (!isAndroid()) return Promise.resolve(false);
  return serial(readKeepSyncChoice);
}

/** Record the user's "Keep sync active" choice and apply it. */
export function setKeepSyncChoice(enabled: boolean): Promise<void> {
  if (!isAndroid()) return Promise.resolve();
  return serial(async () => {
    await Preferences.set({
      key: KEEP_SYNC_CHOICE_KEY,
      value: String(enabled),
    });
    await applyKeepSync(notificationService.isEnabled());
  });
}

/** The top "Notifications" switch: saves it and applies the dependents. */
export function setNotificationsEnabled(enabled: boolean): Promise<void> {
  notificationService.setEnabled(enabled);
  return serial(() => applyUnlocked(enabled));
}

/** Bring the dependents in line with the saved switch (app start). */
export function syncNotificationDependents(): Promise<void> {
  return serial(() => applyUnlocked(notificationService.isEnabled()));
}
