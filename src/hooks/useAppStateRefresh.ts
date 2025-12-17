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

  /**
   * Trigger message sync
   */
  const triggerSync = useCallback(
    async (
      ourPk: UserPublicKeys,
      ourSk: UserSecretKeys,
      session: SessionModule
    ): Promise<void> => {
      if (isSyncing.current) return;
      isSyncing.current = true;
      const isOnline = useOnlineStoreBase.getState().isOnline;

      if (!isOnline) return;
      try {
        await Promise.all([
          announcementService.fetchAndProcessAnnouncements(
            ourPk,
            ourSk,
            session
          ),
          messageService.fetchMessages(
            encodeUserId(ourPk.derive_id()),
            ourSk,
            session
          ),
        ]);
        if (resendFailedBlobs) {
          await resendFailedBlobs();
        }
      } catch (error) {
        console.error('Failed to trigger manual sync:', error);
      } finally {
        isSyncing.current = false;
      }
    },
    [resendFailedBlobs]
  );

  const initApp = useCallback(
    async (
      ourPk: UserPublicKeys,
      ourSk: UserSecretKeys,
      session: SessionModule
    ) => {
      useMessageStore.getState().init();
      await useDiscussionStore.getState().init();
      triggerSync(ourPk, ourSk, session).catch(error => {
        console.error('Failed to sync messages on login:', error);
      });
    },
    [triggerSync]
  );

  useEffect(() => {
    if (userProfile?.userId && ourPk && ourSk && session) {
      initApp(ourPk, ourSk, session);
      const refreshInterval = setInterval(() => {
        triggerSync(ourPk, ourSk, session).catch(error => {
          console.error('Failed to refresh app state periodically:', error);
        });
      }, defaultSyncConfig.activeSyncIntervalMs);

      // Cleanup interval when user logs out or component unmounts
      return () => {
        clearInterval(refreshInterval);
      };
    }
  }, [userProfile?.userId, ourPk, ourSk, session, initApp, triggerSync]);
}
