import { beforeEach, describe, expect, it } from 'vitest';
import { MessageDirection, MessageStatus, MessageType } from '../../src/db/db';
import {
  activeSeekers,
  messages,
  pendingAnnouncements,
  pendingEncryptedMessages,
} from '../../src/db/schema';
import { clearAllTables, getTestConnection, getTestQueries } from '../testDb';

const RESET_STATUSES = new Set([
  MessageStatus.READY,
  MessageStatus.SENDING,
  MessageStatus.SENT,
]);
const STATUSES = Object.values(MessageStatus);

describe('MessagingSessionRecoveryQueries', () => {
  beforeEach(clearAllTables);

  it('resets only resendable outgoing state and preserves incoming/history', async () => {
    const db = getTestConnection().db;
    let timestamp = 1;
    for (const direction of Object.values(MessageDirection)) {
      for (const status of STATUSES) {
        await db.insert(messages).values({
          ownerUserId: 'owner',
          contactUserId: 'contact',
          messageId: new Uint8Array([timestamp]),
          content: `${direction}-${status}`,
          serializedContent: new Uint8Array([9, timestamp]),
          type: MessageType.TEXT,
          direction,
          status,
          timestamp: new Date(timestamp++),
          metadata: '{"preserved":true}',
          encryptedMessage: new Uint8Array([7, 7]),
          seeker: new Uint8Array([8, 8]),
          whenToSend: new Date(1000),
        });
      }
    }
    await db.insert(messages).values({
      ownerUserId: 'owner',
      contactUserId: '__self__',
      content: 'saved message',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date(timestamp++),
      encryptedMessage: new Uint8Array([5]),
      seeker: new Uint8Array([6]),
    });
    await db.insert(activeSeekers).values({ seeker: new Uint8Array([1]) });
    await db.insert(pendingEncryptedMessages).values({
      seeker: new Uint8Array([2]),
      ciphertext: new Uint8Array([3]),
      fetchedAt: new Date(2),
    });
    await db.insert(pendingAnnouncements).values({
      announcement: new Uint8Array([4]),
      fetchedAt: new Date(3),
      counter: '5',
    });

    const before = await db.select().from(messages).all();
    await getTestQueries().messagingSessionRecovery.prepareReset();
    const after = await db.select().from(messages).all();

    expect(after).toHaveLength(before.length);
    for (const original of before) {
      const recovered = after.find(row => row.id === original.id)!;
      const shouldReset =
        original.direction === MessageDirection.OUTGOING &&
        original.contactUserId !== '__self__' &&
        RESET_STATUSES.has(original.status as MessageStatus);
      expect(recovered.status).toBe(
        shouldReset ? MessageStatus.WAITING_SESSION : original.status
      );
      expect(recovered.encryptedMessage).toEqual(
        shouldReset ? null : original.encryptedMessage
      );
      expect(recovered.seeker).toEqual(shouldReset ? null : original.seeker);
      expect(recovered.messageId).toEqual(original.messageId);
      expect(recovered.content).toBe(original.content);
      expect(recovered.serializedContent).toEqual(original.serializedContent);
      expect(recovered.metadata).toBe(original.metadata);
      expect(recovered.whenToSend).toEqual(original.whenToSend);
    }
    await expect(db.select().from(activeSeekers).all()).resolves.toEqual([]);
    await expect(
      db.select().from(pendingEncryptedMessages).all()
    ).resolves.toEqual([]);
    await expect(
      db.select().from(pendingAnnouncements).all()
    ).resolves.toHaveLength(1);
  });
});
