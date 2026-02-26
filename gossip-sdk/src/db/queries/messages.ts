import { eq, and, sql, inArray, asc } from 'drizzle-orm';
import * as schema from '../schema/index.js';
import type { DatabaseConnection } from '../sqlite.js';
import { MessageDirection, MessageStatus, MessageType } from '../../db/db.js';

export type MessageRow = typeof schema.messages.$inferSelect;
export type MessageInsert = typeof schema.messages.$inferInsert;

export class MessageQueries {
  constructor(private conn: DatabaseConnection) {}

  async getById(id: number): Promise<MessageRow | undefined> {
    return this.conn.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, id))
      .get();
  }

  async getByOwnerAndContact(
    ownerUserId: string,
    contactUserId: string
  ): Promise<MessageRow[]> {
    return this.conn.db
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

  async getByOwnerAndSeeker(
    ownerUserId: string,
    seeker: Uint8Array
  ): Promise<MessageRow | undefined> {
    return this.conn.db
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

  async findByMessageId(
    ownerUserId: string,
    contactUserId: string,
    messageId: Uint8Array
  ): Promise<MessageRow | undefined> {
    return this.conn.db
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

  async insert(values: MessageInsert): Promise<number> {
    await this.conn.db.insert(schema.messages).values(values);
    return this.conn.getLastInsertRowId();
  }

  async batchInsert(values: MessageInsert[]): Promise<void> {
    if (values.length === 0) return;
    await this.conn.db.insert(schema.messages).values(values);
  }

  async updateById(id: number, data: Partial<MessageInsert>): Promise<void> {
    await this.conn.db
      .update(schema.messages)
      .set(data)
      .where(eq(schema.messages.id, id));
  }

  async deleteByOwnerAndContact(
    ownerUserId: string,
    contactUserId: string
  ): Promise<void> {
    await this.conn.db
      .delete(schema.messages)
      .where(
        and(
          eq(schema.messages.ownerUserId, ownerUserId),
          eq(schema.messages.contactUserId, contactUserId)
        )
      );
  }

  async deleteDeliveredKeepAlive(ownerUserId: string): Promise<void> {
    await this.conn.db
      .delete(schema.messages)
      .where(
        and(
          eq(schema.messages.ownerUserId, ownerUserId),
          eq(schema.messages.status, MessageStatus.DELIVERED),
          eq(schema.messages.type, MessageType.KEEP_ALIVE)
        )
      );
  }

  async getOutgoingSentByOwner(ownerUserId: string): Promise<MessageRow[]> {
    return this.conn.db
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

  async getWaitingCount(
    ownerUserId: string,
    contactUserId: string
  ): Promise<number> {
    const result = await this.conn.db
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

  async getSendQueue(
    ownerUserId: string,
    contactUserId: string
  ): Promise<MessageRow[]> {
    return this.conn.db
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

  async getByStatus(
    ownerUserId: string,
    status: MessageStatus
  ): Promise<MessageRow[]> {
    return this.conn.db
      .select()
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.ownerUserId, ownerUserId),
          eq(schema.messages.status, status)
        )
      )
      .all();
  }

  async resetSendQueue(
    ownerUserId: string,
    contactUserId: string,
    statuses?: MessageStatus[]
  ): Promise<void> {
    await this.conn.db
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

  async getAnnouncementsByContact(
    ownerUserId: string,
    contactUserId: string
  ): Promise<MessageRow[]> {
    return this.conn.db
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

  async findDuplicateIncoming(
    ownerUserId: string,
    contactUserId: string,
    content: string,
    windowStart: Date,
    windowEnd: Date
  ): Promise<{ id: number } | undefined> {
    return this.conn.db
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
}
