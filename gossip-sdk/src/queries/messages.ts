import { eq, and, sql, inArray, asc } from 'drizzle-orm';
import * as schema from '../schema';
import { getSqliteDb, getLastInsertRowId } from '../sqlite';
import { MessageDirection, MessageStatus, MessageType } from '../db';

export type MessageRow = typeof schema.messages.$inferSelect;
export type MessageInsert = typeof schema.messages.$inferInsert;

export async function getMessageById(
  id: number
): Promise<MessageRow | undefined> {
  return getSqliteDb()
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.id, id))
    .get();
}

export async function getMessagesByOwnerAndContact(
  ownerUserId: string,
  contactUserId: string
): Promise<MessageRow[]> {
  return getSqliteDb()
    .select()
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.ownerUserId, ownerUserId),
        eq(schema.messages.contactUserId, contactUserId)
      )
    )
    .orderBy(asc(schema.messages.timestamp), asc(schema.messages.id))
    .all();
}

export async function getMessageByOwnerAndSeeker(
  ownerUserId: string,
  seeker: Uint8Array
): Promise<MessageRow | undefined> {
  return getSqliteDb()
    .select()
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.ownerUserId, ownerUserId),
        eq(schema.messages.seeker, seeker)
      )
    )
    .get();
}

export async function findMessageByMessageId(
  ownerUserId: string,
  contactUserId: string,
  messageId: Uint8Array
): Promise<MessageRow | undefined> {
  return getSqliteDb()
    .select()
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.ownerUserId, ownerUserId),
        eq(schema.messages.contactUserId, contactUserId),
        eq(schema.messages.messageId, messageId)
      )
    )
    .get();
}

export async function insertMessage(values: MessageInsert): Promise<number> {
  await getSqliteDb().insert(schema.messages).values(values);
  return getLastInsertRowId();
}

export async function batchInsertMessages(
  values: MessageInsert[]
): Promise<void> {
  if (values.length === 0) return;
  await getSqliteDb().insert(schema.messages).values(values);
}

export async function updateMessageById(
  id: number,
  data: Partial<MessageInsert>
): Promise<void> {
  await getSqliteDb()
    .update(schema.messages)
    .set(data)
    .where(eq(schema.messages.id, id));
}

export async function deleteMessagesByOwnerAndContact(
  ownerUserId: string,
  contactUserId: string
): Promise<void> {
  await getSqliteDb()
    .delete(schema.messages)
    .where(
      and(
        eq(schema.messages.ownerUserId, ownerUserId),
        eq(schema.messages.contactUserId, contactUserId)
      )
    );
}

export async function deleteDeliveredKeepAliveMessages(
  ownerUserId: string
): Promise<void> {
  await getSqliteDb()
    .delete(schema.messages)
    .where(
      and(
        eq(schema.messages.ownerUserId, ownerUserId),
        eq(schema.messages.status, MessageStatus.DELIVERED),
        eq(schema.messages.type, MessageType.KEEP_ALIVE)
      )
    );
}

export async function getOutgoingSentMessagesByOwner(
  ownerUserId: string
): Promise<MessageRow[]> {
  return getSqliteDb()
    .select()
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.ownerUserId, ownerUserId),
        eq(schema.messages.direction, MessageDirection.OUTGOING),
        eq(schema.messages.status, MessageStatus.SENT)
      )
    )
    .all();
}

export async function getWaitingMessageCount(
  ownerUserId: string,
  contactUserId: string
): Promise<number> {
  const result = await getSqliteDb()
    .select({ count: sql<number>`count(*)` })
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.ownerUserId, ownerUserId),
        eq(schema.messages.contactUserId, contactUserId),
        eq(schema.messages.status, MessageStatus.WAITING_SESSION)
      )
    )
    .get();
  return result?.count ?? 0;
}

export async function getSendQueueMessages(
  ownerUserId: string,
  contactUserId: string
): Promise<MessageRow[]> {
  return getSqliteDb()
    .select()
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.ownerUserId, ownerUserId),
        eq(schema.messages.contactUserId, contactUserId),
        eq(schema.messages.direction, MessageDirection.OUTGOING),
        inArray(schema.messages.status, [
          MessageStatus.WAITING_SESSION,
          MessageStatus.READY,
        ])
      )
    )
    .orderBy(asc(schema.messages.timestamp), asc(schema.messages.id))
    .all();
}

export async function getMessagesByStatus(
  status: MessageStatus
): Promise<MessageRow[]> {
  return getSqliteDb()
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.status, status))
    .all();
}

/**
 * Reset outgoing messages to WAITING_SESSION, clearing encryption data.
 * @param statuses - If provided, only reset messages with these statuses.
 *                   If omitted, reset ALL outgoing messages for the contact.
 */
export async function resetSendQueueMessages(
  ownerUserId: string,
  contactUserId: string,
  statuses?: MessageStatus[]
): Promise<void> {
  await getSqliteDb()
    .update(schema.messages)
    .set({
      status: MessageStatus.WAITING_SESSION,
      encryptedMessage: null,
      seeker: null,
    })
    .where(
      and(
        eq(schema.messages.ownerUserId, ownerUserId),
        eq(schema.messages.contactUserId, contactUserId),
        eq(schema.messages.direction, MessageDirection.OUTGOING),
        statuses ? inArray(schema.messages.status, statuses) : undefined
      )
    );
}

export async function getAnnouncementMessagesByContact(
  ownerUserId: string,
  contactUserId: string
): Promise<MessageRow[]> {
  return getSqliteDb()
    .select()
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.ownerUserId, ownerUserId),
        eq(schema.messages.contactUserId, contactUserId),
        eq(schema.messages.direction, MessageDirection.INCOMING),
        eq(schema.messages.type, MessageType.ANNOUNCEMENT)
      )
    )
    .all();
}

export async function findDuplicateIncomingMessage(
  ownerUserId: string,
  contactUserId: string,
  content: string,
  windowStart: Date,
  windowEnd: Date
): Promise<{ id: number } | undefined> {
  return getSqliteDb()
    .select({ id: schema.messages.id })
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.ownerUserId, ownerUserId),
        eq(schema.messages.contactUserId, contactUserId),
        eq(schema.messages.direction, MessageDirection.INCOMING),
        eq(schema.messages.content, content),
        sql`${schema.messages.timestamp} >= ${windowStart.getTime()}`,
        sql`${schema.messages.timestamp} <= ${windowEnd.getTime()}`
      )
    )
    .get();
}
