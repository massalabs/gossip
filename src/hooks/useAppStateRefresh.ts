import { useCallback, useEffect, useRef } from 'react';
import { useAccountStore } from '../stores/accountStore';
import { defaultSyncConfig } from '../config/sync';
import { useMessageStore } from '../stores/messageStore.tsx';
import { useDiscussionStore } from '../stores/discussionStore.tsx';
import { useOnlineStoreBase } from '../stores/useOnlineStore.tsx';
import {
  messageService,
  announcementService,
  handleSessionRefresh,
} from 'gossip-sdk';
import { useResendFailedBlobs } from './useResendFailedBlobs.ts';
import { DiscussionStatus } from '../db.ts';

const SESSION_REFRESH_EVERY_N_CYCLES = 5;

/**
 * Hook to refresh app state periodically when the user is logged in.
 * Refreshes announcements, messages, discussions, and contacts.
 */
export function useAppStateRefresh() {
  const { userProfile, session } = useAccountStore();
  const isSyncing = useRef(false);
  const { resendFailedBlobs } = useResendFailedBlobs();
  const isOnline = useOnlineStoreBase(s => s.isOnline);
  const refreshInterval = useRef<NodeJS.Timeout | null>(null);
  const isInitiating = useRef(false);
  const sessionRefreshCycle = useRef(0);
  // Trigger synchronization of announcements, messages, and failed blobs
  const triggerSync = useCallback(
    async (
      session: Parameters<typeof messageService.fetchMessages>[0]
    ): Promise<void> => {
      if (!userProfile?.userId) return;
      if (!isOnline || isSyncing.current) return;
      isSyncing.current = true;

      if (resendFailedBlobs) {
        await resendFailedBlobs();
      }

      try {
        await Promise.all([
          announcementService.fetchAndProcessAnnouncements(session as never),
          messageService.fetchMessages(session as never),
        ]);

        // call refresh session of session manager
        if (
          sessionRefreshCycle.current % SESSION_REFRESH_EVERY_N_CYCLES ===
          0
        ) {
          await handleSessionRefresh(
            userProfile.userId,
            session as never,
            useDiscussionStore
              .getState()
              .getDiscussionsByStatus([DiscussionStatus.ACTIVE])
          );
        }
        sessionRefreshCycle.current++;
      } catch (error) {
        console.error(
          '[useAppStateRefresh] Failed to trigger sync process:',
          error
        );
      } finally {
        isSyncing.current = false;
      }
    },
    [resendFailedBlobs, isOnline, userProfile?.userId]
  );

  // Initialize stores, trigger initial sync, and set up refresh interval
  const init = useCallback(async () => {
    if (isInitiating.current || !session) {
      if (!session) {
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

      await triggerSync(session as never);

      if (refreshInterval.current) {
        clearInterval(refreshInterval.current);
      }

      refreshInterval.current = setInterval(async () => {
        // Fetch fresh values to avoid stale closures
        const { session } = useAccountStore.getState();
        if (session) {
          await triggerSync(session as never);
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
  }, [triggerSync, session]);

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
