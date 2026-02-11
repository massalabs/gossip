import { useEffect } from 'react';
import { useAccountStore } from '../stores/accountStore';
import { useDiscussionStore } from '../stores/discussionStore';
import { useMessageStore } from '../stores/messageStore';
import { gossipSdk } from '@massalabs/gossip-sdk';

/**
 * Hook to initialize all stores when user profile is available
 */
export function useStoreInit() {
  const userProfile = useAccountStore(s => s.userProfile);
  const initDiscussionStore = useDiscussionStore(s => s.init);
  const initMessageStore = useMessageStore(s => s.init);

  useEffect(() => {
    // Only initialize when:
    // 1. User profile is available
    // 2. SDK session is open
    if (userProfile?.userId && gossipSdk.isSessionOpen) {
      // Initialize discussion store (synchronous)
      initDiscussionStore();
      // Initialize message store (async)
      initMessageStore().catch(error => {
        console.error('Failed to initialize message store:', error);
      });
    }
    // Note: gossipSdk.isSessionOpen is not reactive, but by the time userProfile
    // is available, the session should already be open
  }, [userProfile?.userId, initDiscussionStore, initMessageStore]);
}
