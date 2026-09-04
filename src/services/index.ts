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

let outputEpoch = 0;
let activeOutputOwner: { sdk: GossipSdk; epoch: number } | null = null;
let nativeOutputTail = Promise.resolve();

export async function suspendSdkEventOutputs(): Promise<number> {
  activeOutputOwner = null;
  outputEpoch += 1;
  if (Capacitor.isNativePlatform()) await nativeOutputTail;
  return outputEpoch;
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
  webOwnerGeneration: Promise<number | null>,
  publish: () => Promise<void>
): Promise<void> {
  if (!canPublishSdkOutput(gossip, epoch)) return;
  if (!Capacitor.isNativePlatform() && navigator.locks) {
    await navigator.locks.request(
      'gossip-account-output-v1',
      { mode: 'shared' },
      async () => {
        const ownerGeneration = await webOwnerGeneration;
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
  const ownerEpoch = outputEpoch;
  const webOwnerGeneration = Capacitor.isNativePlatform()
    ? Promise.resolve(null)
    : bridgeGet<number>('accountOutputGeneration').then(value => value ?? 0);
  activeOutputOwner = { sdk: gossip, epoch: ownerEpoch };
  // Propagate seekers to SW bridge (web) and BackgroundRunner (mobile)
  gossip.on(SdkEventType.SEEKERS_UPDATED, (seekers: Uint8Array[]) => {
    void withSdkOutputFence(
      gossip,
      ownerEpoch,
      webOwnerGeneration,
      async () => {
        await bridgeSetMany([
          ['activeSeekers', seekers.map(s => Array.from(s))],
          ['accountCleanupBlocked', false],
        ]);
        await setActiveSeekersInPreferences(seekers, ownerEpoch, () =>
          canPublishSdkOutput(gossip, ownerEpoch)
        );
      }
    ).catch(() => {});
  });

  // Show notification for new discussion requests when app is in background
  gossip.on(SdkEventType.SESSION_REQUESTED, async () => {
    const foreground = await isAppInForeground();
    if (!foreground) {
      try {
        await withSdkOutputFence(
          gossip,
          ownerEpoch,
          webOwnerGeneration,
          async () => {
            await notificationService.showNewDiscussionNotification();
            logger.info(
              '[SDK Event] New discussion request notification shown'
            );
          }
        );
      } catch {
        // Output failures are fail-closed and must not recreate diagnostics.
      }
    }
  });

  // Show notification for incoming messages when app is in background
  gossip.on(SdkEventType.MESSAGE_RECEIVED, async message => {
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

      await withSdkOutputFence(gossip, ownerEpoch, webOwnerGeneration, () =>
        notificationService.showDiscussionNotification(message.contactUserId)
      );
    } catch {
      // Output failures are fail-closed and must not recreate diagnostics.
    }
  });

  // Log errors for debugging
  gossip.on(
    SdkEventType.ERROR,
    ({ error, context }: { error: Error; context: string }) => {
      void withSdkOutputFence(
        gossip,
        ownerEpoch,
        webOwnerGeneration,
        async () => logger.error(`[SDK Error:${context}]`, error)
      ).catch(() => {});
    }
  );
}
