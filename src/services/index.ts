import { logger } from '../utils/logger.ts';
/**
 * Service Instances
 *
 * Sets up SDK event handlers and exports auth service.
 * The SDK instance is managed via getSdk().
 */

import {
  SdkEventType,
  MessageDirection,
  GossipSdk,
  MessageType,
} from '@massalabs/gossip-sdk';
import { Capacitor } from '@capacitor/core';
import { notificationService } from './notifications';
import { isPortableImportCleanupPending } from './portableImportCleanup';
import { isAppInForeground } from '../utils/appState';
import { bridgeGet, bridgeSetMany } from '../sw-bridge';
import { setActiveSeekersInPreferences } from '../utils/preferences';
import { useDiscussionStore } from '../stores/discussionStore';
import { useMessageStore } from '../stores/messageStore';
import { useGroupStore } from '../stores/groupStore';

let outputEpoch = 0;
let activeOutputOwner: { sdk: GossipSdk; epoch: number } | null = null;
let nativeOutputTail = Promise.resolve();
// Web only: the service-worker bridge generation this owner may write to.
let webOwnerGeneration: Promise<number | null> = Promise.resolve(null);

function readWebOwnerGeneration(): Promise<number | null> {
  if (Capacitor.isNativePlatform()) return Promise.resolve(null);
  // Not awaited until an output is published. An unreadable bridge yields
  // `null`, which never matches the current generation: publishing stays
  // blocked (fail closed) instead of raising an unhandled rejection.
  return bridgeGet<number>('accountOutputGeneration').then(
    value => value ?? 0,
    () => null
  );
}

/**
 * Stop SDK events from reaching anything outside the encrypted store
 * (background-sync seekers, notifications, logs). Outputs already accepted
 * are drained on native. Returns the new epoch.
 */
export async function suspendSdkEventOutputs(): Promise<number> {
  activeOutputOwner = null;
  outputEpoch += 1;
  if (Capacitor.isNativePlatform()) await nativeOutputTail;
  return outputEpoch;
}

/**
 * Let SDK events reach outside outputs again, for the account that was just
 * opened. Events raised before the last suspension stay dropped.
 */
export function resumeSdkEventOutputs(gossip: GossipSdk): void {
  webOwnerGeneration = readWebOwnerGeneration();
  activeOutputOwner = { sdk: gossip, epoch: outputEpoch };
}

function canPublishSdkOutput(gossip: GossipSdk, epoch: number): boolean {
  return (
    activeOutputOwner?.sdk === gossip &&
    activeOutputOwner.epoch === epoch &&
    !isPortableImportCleanupPending()
  );
}

async function withSdkOutputFence(
  gossip: GossipSdk,
  epoch: number,
  ownerGenerationAtEvent: Promise<number | null>,
  publish: () => Promise<void>
): Promise<void> {
  if (!canPublishSdkOutput(gossip, epoch)) return;
  if (!Capacitor.isNativePlatform() && navigator.locks) {
    await navigator.locks.request(
      'gossip-account-output-v1',
      { mode: 'shared' },
      async () => {
        const ownerGeneration = await ownerGenerationAtEvent;
        const currentGeneration =
          (await bridgeGet<number>('accountOutputGeneration')) ?? 0;
        if (
          canPublishSdkOutput(gossip, epoch) &&
          ownerGeneration === currentGeneration
        ) {
          await publish();
        }
      }
    );
    return;
  }
  if (Capacitor.isNativePlatform()) {
    const predecessor = nativeOutputTail;
    let release!: () => void;
    nativeOutputTail = new Promise<void>(resolve => {
      release = resolve;
    });
    await predecessor;
    try {
      if (canPublishSdkOutput(gossip, epoch)) await publish();
    } finally {
      release();
    }
    return;
  }
  if (canPublishSdkOutput(gossip, epoch)) await publish();
}

/**
 * Wire up SDK events to app behaviors like notifications.
 *
 * Note: Zustand stores poll SQLite via SDK service APIs and listen to SDK events
 * for immediate refetch. The event handlers here are primarily for side effects
 * like notifications.
 */
export function setupSdkEventHandlers(gossip: GossipSdk): void {
  resumeSdkEventOutputs(gossip);
  // Each event is bound to the owner current when it was raised, so an event
  // raised before a lock can never publish after it.
  const owner = () => ({
    epoch: outputEpoch,
    generation: webOwnerGeneration,
  });
  // Propagate seekers to SW bridge (web) and BackgroundRunner (mobile)
  gossip.on(SdkEventType.SEEKERS_UPDATED, (seekers: Uint8Array[]) => {
    const { epoch: ownerEpoch, generation } = owner();
    void withSdkOutputFence(gossip, ownerEpoch, generation, async () => {
      await bridgeSetMany([
        ['activeSeekers', seekers.map(s => Array.from(s))],
        ['accountCleanupBlocked', false],
      ]);
      await setActiveSeekersInPreferences(seekers, ownerEpoch, () =>
        canPublishSdkOutput(gossip, ownerEpoch)
      );
    }).catch(() => {});
  });

  // Show notification for new discussion requests when app is in background
  gossip.on(SdkEventType.SESSION_REQUESTED, async () => {
    const { epoch: ownerEpoch, generation } = owner();
    const foreground = await isAppInForeground();
    if (!foreground) {
      try {
        await withSdkOutputFence(gossip, ownerEpoch, generation, async () => {
          await notificationService.showNewDiscussionNotification();
          logger.info('[SDK Event] New discussion request notification shown');
        });
      } catch {
        // Output failures are fail-closed and must not recreate diagnostics.
      }
    }
  });

  // Show notification for incoming messages when app is in background
  gossip.on(SdkEventType.MESSAGE_RECEIVED, async message => {
    const { epoch: ownerEpoch, generation } = owner();
    // Only notify for incoming messages
    if (message.direction !== MessageDirection.INCOMING) return;

    // Don't notify for keep-alive messages
    if (message.type === MessageType.KEEP_ALIVE) return;
    // Don't notify if user is currently viewing this discussion
    const currentContact = useMessageStore.getState().currentContactUserId;
    if (currentContact === message.contactUserId) return;

    try {
      const foreground = await isAppInForeground();
      if (foreground) return;

      // Mute check: prefer the hydrated store; right after resume the store
      // can still be empty, so fall back to the SDK (SQLite) — otherwise a
      // muted contact would notify anyway.
      const { discussions } = useDiscussionStore.getState();
      let discussion = discussions.find(
        d => d.contactUserId === message.contactUserId
      );
      if (!discussion && discussions.length === 0 && gossip.isSessionOpen) {
        const dbDiscussions = await gossip.discussions.list();
        discussion = dbDiscussions.find(
          d => d.contactUserId === message.contactUserId
        );
      }
      if (discussion?.mutedNotifications) return;

      await withSdkOutputFence(gossip, ownerEpoch, generation, () =>
        notificationService.showDiscussionNotification(message.contactUserId)
      );
    } catch {
      // Output failures are fail-closed and must not recreate diagnostics.
    }
  });

  // Group activity: the same generic notification as a one-to-one message,
  // without naming the group.
  gossip.on(SdkEventType.GROUPS_CHANGED, async ({ changes }) => {
    const { epoch: ownerEpoch, generation } = owner();
    const current = useGroupStore.getState().currentGroupId;
    const notify = changes.some(
      c =>
        (c.kind === 'Messages' && c.groupId !== current) ||
        c.kind === 'Invitation'
    );
    if (!notify) return;
    try {
      if (await isAppInForeground()) return;
      await withSdkOutputFence(gossip, ownerEpoch, generation, () =>
        notificationService.showGroupNotification()
      );
    } catch {
      // Output failures are fail-closed and must not recreate diagnostics.
    }
  });

  // Log errors for debugging
  gossip.on(
    SdkEventType.ERROR,
    ({ error, context }: { error: Error; context: string }) => {
      const { epoch: ownerEpoch, generation } = owner();
      void withSdkOutputFence(gossip, ownerEpoch, generation, async () =>
        logger.error(`[SDK Error:${context}]`, error)
      ).catch(() => {});
    }
  );
}
