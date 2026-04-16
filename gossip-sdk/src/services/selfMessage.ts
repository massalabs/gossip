import { Queries } from '../db/queries/index.js';
import type { EncryptionKey } from '../wasm/encryption.js';
import {
  decryptAead,
  encryptAead,
  nonceFromBytes,
} from '../wasm/encryption.js';
import {
  type Message,
  MessageDirection,
  MessageStatus,
  MessageType,
  MESSAGE_ID_SIZE,
} from '../db/db.js';
import { discussions } from '../db/schema/index.js';
import { encodeToBase64, decodeFromBase64 } from '../utils/base64.js';

export const SELF_CONTACT_ID = '__self__';

const AAD_EMPTY = new Uint8Array(0);
const ZERO_NONCE_BYTES = new Uint8Array(16);

export class SelfMessageService {
  constructor(
    private readonly queries: Queries,
    private readonly ownerUserId: string,
    private readonly encryptionKey: EncryptionKey
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

  private async encryptContent(plaintext: string): Promise<string> {
    const nonce = await nonceFromBytes(ZERO_NONCE_BYTES);
    const ciphertext = await encryptAead(
      this.encryptionKey,
      nonce,
      new TextEncoder().encode(plaintext),
      AAD_EMPTY
    );

    // Store only ciphertext; nonce is a fixed zero value for all messages.
    return encodeToBase64(ciphertext);
  }

  private async decryptContent(content: string): Promise<string> {
    const cipherBytes = decodeFromBase64(content);
    const nonce = await nonceFromBytes(ZERO_NONCE_BYTES);
    const plaintextBytes = await decryptAead(
      this.encryptionKey,
      nonce,
      cipherBytes,
      AAD_EMPTY
    );

    if (!plaintextBytes) {
      throw new Error('Failed to decrypt self message');
    }

    return new TextDecoder().decode(plaintextBytes);
  }

  async send(content: string): Promise<Message> {
    const encryptedContent = await this.encryptContent(content);
    const now = new Date();
    const messageId = crypto.getRandomValues(new Uint8Array(MESSAGE_ID_SIZE));

    const id = await this.queries.messages.insert({
      ownerUserId: this.ownerUserId,
      contactUserId: SELF_CONTACT_ID,
      content: encryptedContent,
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: now,
      messageId,
    });

    const discussion = await this.queries.discussions.getByOwnerAndContact(
      this.ownerUserId,
      SELF_CONTACT_ID
    );

    if (discussion?.id != null) {
      await this.queries.discussions.updateById(discussion.id, {
        lastMessageId: id,
        lastMessageContent: null,
        lastMessageTimestamp: now,
        updatedAt: now,
      });
    }

    return {
      id,
      messageId,
      ownerUserId: this.ownerUserId,
      contactUserId: SELF_CONTACT_ID,
      content,
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: now,
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
        const plaintext = await this.decryptContent(row.content);
        result.push({
          id: row.id,
          messageId: row.messageId ?? undefined,
          ownerUserId: row.ownerUserId,
          contactUserId: row.contactUserId,
          content: plaintext,
          type: row.type,
          direction: MessageDirection.OUTGOING,
          status: row.status,
          timestamp: row.timestamp,
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

    const encryptedContent = await this.encryptContent(newContent);
    const existingMetadata = row.metadata
      ? JSON.parse(row.metadata as string)
      : {};

    await this.queries.messages.updateById(row.id, {
      content: encryptedContent,
      metadata: JSON.stringify({ ...existingMetadata, edited: true }),
    });
  }

  async deleteMessage(id: number): Promise<void> {
    const row = await this.queries.messages.getById(id);
    if (!row) return;

    // Delete any reactions that reference this message via metadata.originalMessageId
    if (row.messageId) {
      const messageIdBase64 = encodeToBase64(row.messageId);
      const reactions =
        await this.queries.messages.getReactionsByOwnerAndContact(
          this.ownerUserId,
          SELF_CONTACT_ID
        );

      const toDelete = reactions.filter(r => {
        if (!r.metadata) return false;
        try {
          const meta = JSON.parse(r.metadata as string);
          return meta?.originalMessageId === messageIdBase64;
        } catch {
          return false;
        }
      });

      for (const reaction of toDelete) {
        await this.queries.messages.deleteById(reaction.id);
      }
    }

    await this.queries.messages.deleteById(row.id);
  }

  async sendReaction(
    emoji: string,
    originalMessageDbId: number
  ): Promise<{
    id: number;
    messageId: Uint8Array;
    emoji: string;
    originalMessageId: Uint8Array;
  }> {
    const originalRow =
      await this.queries.messages.getById(originalMessageDbId);
    if (!originalRow || !originalRow.messageId) {
      throw new Error(
        'Original message not found or has no messageId for reaction'
      );
    }
    const originalMessageId = originalRow.messageId;

    const encryptedEmoji = await this.encryptContent(emoji);
    const now = new Date();
    const messageId = crypto.getRandomValues(new Uint8Array(MESSAGE_ID_SIZE));
    const originalMessageIdBase64 = encodeToBase64(originalMessageId);

    const id = await this.queries.messages.insert({
      ownerUserId: this.ownerUserId,
      contactUserId: SELF_CONTACT_ID,
      content: encryptedEmoji,
      type: MessageType.REACTION,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: now,
      messageId,
      metadata: JSON.stringify({
        originalMessageId: originalMessageIdBase64,
      }),
    });

    return { id, messageId, emoji, originalMessageId };
  }

  async removeReaction(reactionId: number): Promise<void> {
    const row = await this.queries.messages.getById(reactionId);
    if (!row) return;
    await this.queries.messages.deleteById(row.id);
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
    {
      id: number;
      messageId: Uint8Array;
      emoji: string;
      originalMessageId: Uint8Array;
    }[]
  > {
    const rows = await this.queries.messages.getReactionsByOwnerAndContact(
      this.ownerUserId,
      SELF_CONTACT_ID
    );

    const result: {
      id: number;
      messageId: Uint8Array;
      emoji: string;
      originalMessageId: Uint8Array;
    }[] = [];

    for (const row of rows) {
      if (!row.messageId) continue;
      try {
        const emoji = await this.decryptContent(row.content);
        const meta = row.metadata ? JSON.parse(row.metadata as string) : null;
        const originalMessageIdRaw = meta?.originalMessageId;
        if (typeof originalMessageIdRaw !== 'string') continue;
        const originalMessageId = decodeFromBase64(originalMessageIdRaw);
        result.push({
          id: row.id,
          messageId: row.messageId,
          emoji,
          originalMessageId,
        });
      } catch {
        // Skip reactions that cannot be decrypted
      }
    }

    return result;
  }
}
