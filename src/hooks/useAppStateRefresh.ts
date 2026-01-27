import { useCallback, useEffect, useRef } from 'react';
import { useAccountStore } from '../stores/accountStore';
import { gossipSdk } from '@massalabs/gossip-sdk';
import { defaultSyncConfig } from '../config/sync';
import { useMessageStore } from '../stores/messageStore.tsx';
import { useDiscussionStore } from '../stores/discussionStore.tsx';
import { useOnlineStoreBase } from '../stores/useOnlineStore.tsx';
import { useResendFailedBlobs } from './useResendFailedBlobs.ts';
import { DiscussionStatus } from '../db.ts';

const SESSION_REFRESH_EVERY_N_CYCLES = 5;

/**
 * Hook to refresh app state periodically when the user is logged in.
 * Refreshes announcements, messages, discussions, and contacts.
 */
export function useAppStateRefresh() {
  const userProfile = useAccountStore(s => s.userProfile);
  const isSyncing = useRef(false);
  const { resendFailedBlobs } = useResendFailedBlobs();
  const isOnline = useOnlineStoreBase(s => s.isOnline);
  const refreshInterval = useRef<NodeJS.Timeout | null>(null);
  const isInitiating = useRef(false);
  const sessionRefreshCycle = useRef(0);

  // Trigger synchronization of announcements, messages, and failed blobs
  const triggerSync = useCallback(async (): Promise<void> => {
    if (!userProfile?.userId || !gossipSdk.isSessionOpen) return;
    if (!isOnline || isSyncing.current) return;
    isSyncing.current = true;

    if (resendFailedBlobs) {
      await resendFailedBlobs();
    }

    try {
      await Promise.all([
        gossipSdk.announcements.fetch(),
        gossipSdk.messages.fetch(),
      ]);

      // call refresh session of session manager
      if (sessionRefreshCycle.current % SESSION_REFRESH_EVERY_N_CYCLES === 0) {
        await gossipSdk.refresh.handleSessionRefresh(
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
  }, [resendFailedBlobs, isOnline, userProfile?.userId]);

  // Initialize stores, trigger initial sync, and set up refresh interval
  const init = useCallback(async () => {
    if (isInitiating.current || !gossipSdk.isSessionOpen) {
      if (!gossipSdk.isSessionOpen) {
        console.warn('Cannot initialize app state: Session not available');
      }
      return;
    }

    isInitiating.current = true;

    try {
      useMessageStore.getState().init();
      await useDiscussionStore.getState().init();

      await triggerSync();

      if (refreshInterval.current) {
        clearInterval(refreshInterval.current);
      }

      refreshInterval.current = setInterval(async () => {
        // Check if session is still open
        if (gossipSdk.isSessionOpen) {
          await triggerSync();
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
  }, [triggerSync]);

  // Run init on user login and clean up on unmount or logout
  useEffect(() => {
    if (userProfile?.userId && gossipSdk.isSessionOpen) {
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
