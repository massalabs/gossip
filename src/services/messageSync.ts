/**
 * Message Sync Utilities
 *
 * Handles manual message sync. Initialization is handled by setupServiceWorker.
 */

import { messageService } from './message';
import { announcementService } from './announcement';
import { useOnlineStoreBase } from '../stores/useOnlineStore';
import { setLastSyncTimestamp } from '../utils/preferences';
import {
  UserPublicKeys,
  UserSecretKeys,
} from '../assets/generated/wasm/gossip_wasm';
import { SessionModule } from '../wasm/session';
import { encodeUserId } from '../utils/userId';

/**
 * Trigger manual message sync
 */
export async function triggerManualSync(
  ourPk: UserPublicKeys,
  ourSk: UserSecretKeys,
  session: SessionModule
): Promise<void> {
  const isOnline = useOnlineStoreBase.getState().isOnline;

  if (!isOnline) return;
  try {
    await Promise.all([
      announcementService.fetchAndProcessAnnouncements(ourPk, ourSk, session),
      messageService.fetchMessages(
        encodeUserId(ourPk.derive_id()),
        ourSk,
        session
      ),
    ]);
  } catch (error) {
    console.error('Failed to trigger manual sync:', error);
  }

  // Update last sync timestamp after successful sync
  await setLastSyncTimestamp();
}
