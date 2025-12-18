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
 * Hook to refresh app state periodically when the user is logged in.
 * Refreshes announcements, messages, discussions, and contacts.
 */
export function useAppStateRefresh() {
  const { userProfile, ourPk, ourSk, session } = useAccountStore();
  const isSyncing = useRef(false);
  const { resendFailedBlobs } = useResendFailedBlobs();
  const isOnline = useOnlineStoreBase(s => s.isOnline);
  const refreshInterval = useRef<NodeJS.Timeout | null>(null);
  const isInitiating = useRef(false);

  // Trigger synchronization of announcements, messages, and failed blobs
  const triggerSync = useCallback(
    async (
      ourPk: UserPublicKeys,
      ourSk: UserSecretKeys,
      session: SessionModule
    ): Promise<void> => {
      if (!isOnline || isSyncing.current) return;
      isSyncing.current = true;

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

  // Initialize stores, trigger initial sync, and set up refresh interval
  const init = useCallback(async () => {
    if (isInitiating.current || !ourPk || !ourSk || !session) {
      if (!ourPk || !ourSk || !session) {
        console.warn(
          'Cannot initialize app state: User keys or session not available'
        );
      }
      return;
    }

    isInitiating.current = true;

    try {
      useMessageStore.getState().init();
      await useDiscussionStore.getState().init();

      await triggerSync(ourPk, ourSk, session);

      if (refreshInterval.current) {
        clearInterval(refreshInterval.current);
      }

      refreshInterval.current = setInterval(async () => {
        // Fetch fresh values to avoid stale closures
        const { ourPk, ourSk, session } = useAccountStore.getState();
        if (ourPk && ourSk && session) {
          await triggerSync(ourPk, ourSk, session);
        }
      }, defaultSyncConfig.activeSyncIntervalMs);
    } catch (error) {
      console.error(
        '[useAppStateRefresh] Failed to initialize app state:',
        error
      );
    } finally {
      isInitiating.current = false;
    }
  }, [triggerSync, ourPk, ourSk, session]);

  // Run init on user login and clean up on unmount or logout
  useEffect(() => {
    if (userProfile?.userId) {
      init();
    }

    return () => {
      if (refreshInterval.current) {
        clearInterval(refreshInterval.current);
        refreshInterval.current = null;
      }
    };
  }, [userProfile?.userId, init]);
}
