import { Queries } from '../db/queries/index.js';
import {
  type Message,
  MessageDirection,
  MessageStatus,
  MessageType,
} from '../db/db.js';
import { discussions, messages } from '../db/schema/index.js';
import { or, eq, sql, and } from 'drizzle-orm';

export const SELF_CONTACT_ID = '__self__';

export class SelfMessageService {
  constructor(
    private readonly queries: Queries,
    private readonly ownerUserId: string
  ) {}

  async ensureDiscussionExists(): Promise<void> {
    const existing = await this.queries.discussions.getByOwnerAndContact(
      this.ownerUserId,
      SELF_CONTACT_ID
    );

    if (existing) return;

    const now = new Date();

    await this.queries.discussions.insert({
      ownerUserId: this.ownerUserId,
      contactUserId: SELF_CONTACT_ID,
      weAccepted: true,
      sendAnnouncement: null,
      direction: 'initiated',
      nextSeeker: null,
      initiationAnnouncement: null,
      announcementMessage: null,
      lastSyncTimestamp: null,
      customName: null,
      lastMessageId: null,
      lastMessageContent: null,
      lastMessageTimestamp: null,
      unreadCount: 0,
      pinned: false,
      killedNextRetryAt: null,
      saturatedRetryAt: null,
      saturatedRetryDone: false,
      createdAt: now,
      updatedAt: now,
    } as typeof discussions.$inferInsert);
  }

  isSelfMessage(message: Message): boolean {
    return message.contactUserId === SELF_CONTACT_ID;
  }

  repliedMessageId(message: Message): number | null {
    if (!this.isSelfMessage(message)) {
      return null;
    }

    const value = message.metadata?.originalMessageId;
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string') {
      const parsed = Number.parseInt(value, 10);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }

  async send(message: Message): Promise<Message> {
    const id = await this.queries.messages.insert({
      ...message,
      ownerUserId: this.ownerUserId,
      forwardOf: message.forwardOf ? JSON.stringify(message.forwardOf) : null,
      metadata: message.metadata ? JSON.stringify(message.metadata) : null,
    } as typeof messages.$inferInsert);

    const retrievedMessage = await this.get(id);
    if (!retrievedMessage) {
      throw new Error('Failed to send message');
    }
    return retrievedMessage;
  }

  async get(id: number): Promise<Message | undefined> {
    const row = await this.queries.messages.getById(id);
    if (!row) return undefined;

    let metadata: Record<string, unknown> | undefined;
    if (row.metadata) {
      try {
        metadata = JSON.parse(row.metadata as string) as Record<
          string,
          unknown
        >;
      } catch {
        metadata = undefined;
      }
    }

    return {
      id: row.id,
      ownerUserId: row.ownerUserId,
      contactUserId: row.contactUserId,
      content: row.content,
      type: row.type,
      direction: MessageDirection.OUTGOING,
      status: row.status,
      timestamp: row.timestamp,
      forwardOf: row.forwardOf
        ? JSON.parse(row.forwardOf as string)
        : undefined,
      deleteOf: row.deleteOf ? JSON.parse(row.deleteOf as string) : undefined,
      editOf: row.editOf ? JSON.parse(row.editOf as string) : undefined,
      metadata,
    };
  }

  async getMessages(): Promise<Message[]> {
    const rows = await this.queries.messages.getVisibleByOwnerAndContact(
      this.ownerUserId,
      SELF_CONTACT_ID
    );

    const result: Message[] = [];

    for (const row of rows) {
      try {
        let metadata: Record<string, unknown> | undefined;
        if (row.metadata) {
          try {
            metadata = JSON.parse(row.metadata as string) as Record<
              string,
              unknown
            >;
          } catch {
            metadata = undefined;
          }
        }

        result.push({
          id: row.id,
          ownerUserId: row.ownerUserId,
          contactUserId: row.contactUserId,
          content: row.content,
          type: row.type,
          forwardOf: row.forwardOf
            ? JSON.parse(row.forwardOf as string)
            : undefined,
          direction: MessageDirection.OUTGOING,
          status: row.status,
          timestamp: row.timestamp,
          metadata,
        });
      } catch {
        // Skip messages that cannot be decrypted
      }
    }
    return result;
  }

  async editMessage(id: number, newContent: string): Promise<void> {
    const row = await this.queries.messages.getById(id);
    if (!row) return;

    const existingMetadata = row.metadata
      ? JSON.parse(row.metadata as string)
      : {};

    await this.queries.messages.updateById(id, {
      content: newContent,
      metadata: JSON.stringify({ ...existingMetadata, edited: true }),
    });
  }

  async deleteMessage(id: number): Promise<void> {
    await this.queries.conn.db
      .delete(messages)
      .where(
        or(
          eq(messages.id, id),
          and(
            eq(messages.type, MessageType.REACTION),
            sql`json_extract(${messages.metadata}, '$.originalMessageId') = ${id}`
          )
        )
      );

    // Remove $.originalMessageId from metadata of any message that references the deleted message
    await this.queries.conn.db
      .update(messages)
      .set({
        metadata: sql`json_remove(${messages.metadata}, '$.originalMessageId')`,
      })
      .where(
        sql`json_extract(${messages.metadata}, '$.originalMessageId') = ${id}`
      );

    // const toDelete = reactions.filter(row => {
    //   if (!row.metadata) return false;
    //   try {
    //     const meta = JSON.parse(row.metadata as string);
    //     return meta?.originalMessageId === id;
    //   } catch {
    //     return false;
    //   }
    // });

    // for (const reaction of toDelete) {
    //   await this.queries.messages.deleteById(reaction.id);
    // }

    // await this.queries.messages.deleteById(id);
  }

  async sendReaction(
    emoji: string,
    originalMessageDbId: number
  ): Promise<{ id: number; emoji: string; originalMessageId: number }> {
    const now = new Date();

    const id = await this.queries.messages.insert({
      ownerUserId: this.ownerUserId,
      contactUserId: SELF_CONTACT_ID,
      content: emoji,
      type: MessageType.REACTION,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: now,
      metadata: JSON.stringify({ originalMessageId: originalMessageDbId }),
    });

    return { id, emoji, originalMessageId: originalMessageDbId };
  }

  async removeReaction(reactionId: number): Promise<void> {
    await this.queries.messages.deleteById(reactionId);
  }

  async getRetentionInfo(): Promise<{
    duration: number | null;
    setAt: number | null;
  }> {
    const row = await this.queries.discussions.getByOwnerAndContact(
      this.ownerUserId,
      SELF_CONTACT_ID
    );
    return {
      duration: row?.messageRetentionDuration ?? null,
      setAt: row?.retentionPolicySetAt ?? null,
    };
  }

  async setRetentionPolicy(durationSeconds: number | null): Promise<void> {
    const duration =
      durationSeconds != null && durationSeconds > 0 ? durationSeconds : null;
    await this.queries.discussions.updateByOwnerAndContact(
      this.ownerUserId,
      SELF_CONTACT_ID,
      {
        messageRetentionDuration: duration,
        retentionPolicySetAt: duration ? Date.now() : null,
      }
    );
  }

  async getReactions(): Promise<
    { id: number; emoji: string; originalMessageId: number }[]
  > {
    const rows = await this.queries.messages.getReactionsByOwnerAndContact(
      this.ownerUserId,
      SELF_CONTACT_ID
    );

    const result: { id: number; emoji: string; originalMessageId: number }[] =
      [];

    for (const row of rows) {
      try {
        const meta = row.metadata ? JSON.parse(row.metadata as string) : null;
        const originalMessageId = meta?.originalMessageId;
        if (typeof originalMessageId === 'number') {
          result.push({ id: row.id, emoji: row.content, originalMessageId });
        }
      } catch {
        // Skip reactions that cannot be decrypted
      }
    }

    return result;
  }
}
