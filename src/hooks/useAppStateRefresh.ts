import { useCallback, useEffect, useRef } from 'react';
import { useAccountStore } from '../stores/accountStore';
import { defaultSyncConfig } from '../config/sync';
import { useMessageStore } from '../stores/messageStore.tsx';
import { useDiscussionStore } from '../stores/discussionStore.tsx';
import {
  UserPublicKeys,
  UserSecretKeys,
} from '../assets/generated/wasm/gossip_wasm';
import { SessionModule } from '../wasm/session.ts';
import { useOnlineStoreBase } from '../stores/useOnlineStore.tsx';
import { messageService } from '../services/message.ts';
import { announcementService } from '../services/announcement.ts';
import { encodeUserId } from '../utils/userId.ts';
import { useResendFailedBlobs } from './useResendFailedBlobs.ts';

/**
 * Hook to refresh app state periodically when user is logged in
 * Refreshes announcements, messages, discussions, and contacts
 */
export function useAppStateRefresh() {
  const { userProfile, ourPk, ourSk, session } = useAccountStore();
  const isSyncing = useRef(false);
  const { resendFailedBlobs } = useResendFailedBlobs(true);
  const isOnline = useOnlineStoreBase(s => s.isOnline);
  const refreshInterval = useRef<NodeJS.Timeout | null>(null);
  const isInitiating = useRef(false);

  /**
   * Trigger message sync
   */
  const triggerSync = useCallback(
    async (
      ourPk: UserPublicKeys,
      ourSk: UserSecretKeys,
      session: SessionModule
    ): Promise<void> => {
      if (!isOnline) return;
      if (isSyncing.current) return;
      isSyncing.current = true;

      try {
        await announcementService.fetchAndProcessAnnouncements(
          ourPk,
          ourSk,
          session
        );

        await messageService.fetchMessages(
          encodeUserId(ourPk.derive_id()),
          ourSk,
          session
        );

        if (resendFailedBlobs) {
          await resendFailedBlobs();
        }
      } catch (error) {
        console.error(
          '[useAppStateRefresh] Failed to trigger sync process:',
          error
        );
      } finally {
        isSyncing.current = false;
      }
    },
    [resendFailedBlobs, isOnline]
  );

  const init = useCallback(async () => {
    if (isInitiating.current) return;

    try {
      if (!ourPk || !ourSk || !session) {
        throw new Error(
          'Failed to initialize app state: User public keys or secret keys or session not initialized'
        );
      }

      isInitiating.current = true;

      useMessageStore.getState().init();
      await useDiscussionStore.getState().init();

      await triggerSync(ourPk, ourSk, session);

      if (refreshInterval.current) {
        clearInterval(refreshInterval.current);
      }

      refreshInterval.current = setInterval(async () => {
        await triggerSync(ourPk, ourSk, session);
      }, defaultSyncConfig.activeSyncIntervalMs);
    } catch (error) {
      console.error(
        '[useAppStateRefresh] Failed to sync messages on login:',
        error
      );
    } finally {
      isInitiating.current = false;
    }
  }, [triggerSync, ourPk, ourSk, session]);

  useEffect(() => {
    if (userProfile?.userId) {
      init();
    }

    return () => {
      if (refreshInterval.current) {
        clearInterval(refreshInterval.current);
      }
    };
  }, [userProfile?.userId, init]);
}
