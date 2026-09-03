import { and, eq, inArray, ne } from 'drizzle-orm';
import { MessageDirection, MessageStatus } from '../db.js';
import type { DatabaseConnection } from '../sqlite.js';
import {
  activeSeekers,
  messages,
  pendingEncryptedMessages,
} from '../schema/index.js';

/**
 * Prepare account-local SQL state for an explicitly confirmed loss of the
 * encrypted SessionManager. The transaction preserves readable history,
 * stable message IDs, pending announcements, contacts, and settings.
 */
export class MessagingSessionRecoveryQueries {
  constructor(private readonly conn: DatabaseConnection) {}

  async prepareReset(): Promise<void> {
    await this.conn.withTransaction(async tx => {
      await tx.delete(activeSeekers);
      await tx.delete(pendingEncryptedMessages);
      await tx
        .update(messages)
        .set({
          status: MessageStatus.WAITING_SESSION,
          encryptedMessage: null,
          seeker: null,
        })
        .where(
          and(
            eq(messages.direction, MessageDirection.OUTGOING),
            // Self-messages are local encrypted storage, not peer queues.
            ne(messages.contactUserId, '__self__'),
            inArray(messages.status, [
              MessageStatus.READY,
              MessageStatus.SENDING,
              MessageStatus.SENT,
            ])
          )
        );
    });
  }
}
