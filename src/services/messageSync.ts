/**
 * Message Sync Utilities
 *
 * Handles manual message sync. Initialization is handled by setupServiceWorker.
 */

import { messageService } from './message';
import { announcementService } from './announcement';
import { useOnlineStoreBase } from '../stores/useOnlineStore';

/**
 * Trigger manual message sync
 */
export async function triggerManualSync(): Promise<void> {
  const isOnline = useOnlineStoreBase.getState().isOnline;

  if (!isOnline) {
    return;
  }

  await Promise.all([
    announcementService.fetchAndProcessAnnouncements(),
    messageService.fetchMessages(),
  ]);
}
