import { useCallback, useEffect, useRef } from 'react';
import { useAccountStore } from '../stores/accountStore';
import { defaultSyncConfig } from '../config/sync';
import { useMessageStore } from '../stores/messageStore.tsx';
import { useDiscussionStore } from '../stores/discussionStore.tsx';
import { SessionModule } from '../wasm/session.ts';
import { useOnlineStoreBase } from '../stores/useOnlineStore.tsx';
import { messageService } from '../services/message.ts';
import { announcementService } from '../services/announcement.ts';
import { useResendFailedBlobs } from './useResendFailedBlobs.ts';
import { DiscussionStatus } from '../db.ts';
import { handleSessionRefresh } from '../services/refresh.ts';
import { useAppStore } from '../stores/appStore.tsx';

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
  const lockActivated = useAppStore(s => s.lockActivated);
  const setLockActivated = useAppStore(s => s.setLockActivated);
  const lockActivatedRef = useRef(lockActivated);

  // Trigger synchronization of announcements, messages, and failed blobs
  const triggerSync = useCallback(
    async (session: SessionModule): Promise<void> => {
      if (!userProfile?.userId) return;
      if (!isOnline || isSyncing.current || lockActivatedRef.current) return;
      setLockActivated(true);
      isSyncing.current = true;

      try {
        if (resendFailedBlobs) {
          await resendFailedBlobs();
        }

        await Promise.all([
          announcementService.fetchAndProcessAnnouncements(session),
          messageService.fetchMessages(session),
        ]);

        // call refresh session of session manager
        if (
          sessionRefreshCycle.current % SESSION_REFRESH_EVERY_N_CYCLES ===
          0
        ) {
          await handleSessionRefresh(
            userProfile.userId,
            session,
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
        setLockActivated(false);
      }
    },
    [resendFailedBlobs, isOnline, userProfile?.userId, setLockActivated]
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

      await triggerSync(session);

      if (refreshInterval.current) {
        clearInterval(refreshInterval.current);
      }

      refreshInterval.current = setInterval(async () => {
        // Fetch fresh values to avoid stale closures
        const { session } = useAccountStore.getState();
        if (session) {
          await triggerSync(session);
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
