import { retentionToMessageTimer } from '@massalabs/gossip-sdk';
import { useAppStore } from '../stores/appStore';

/**
 * The message timer (§7.7, milliseconds, 0 = forever) this account gives a
 * new chat: its default retention, the earlier "1 month" read as 28 days.
 */
export function useDefaultMessageTimer(): number {
  const seconds = useAppStore(s => s.defaultRetentionDuration);
  return retentionToMessageTimer(seconds);
}
