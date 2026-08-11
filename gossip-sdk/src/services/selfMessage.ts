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

  private serializeForwardOf(forwardOf: Message['forwardOf']): string | null {
    if (!forwardOf) return null;
    return JSON.stringify({
      originalContent: forwardOf.originalContent,
      originalContactId: forwardOf.originalContactId
        ? encodeToBase64(forwardOf.originalContactId)
        : undefined,
    });
  }

  private deserializeForwardOf(
    json: string | null | undefined
  ): Message['forwardOf'] {
    if (!json) return undefined;
    try {
      const parsed = JSON.parse(json) as {
        originalContent?: string;
        originalContactId?: string;
      };
      return {
        originalContent: parsed.originalContent,
        originalContactId: parsed.originalContactId
          ? decodeFromBase64(parsed.originalContactId)
          : undefined,
      };
    } catch {
      return undefined;
    }
  }

  /** Encrypt forwardOf JSON for at-rest storage (same AEAD as content). */
  private async encryptForwardOf(
    forwardOf: Message['forwardOf']
  ): Promise<string | null> {
    const json = this.serializeForwardOf(forwardOf);
    if (!json) return null;
    return this.encryptContent(json);
  }

  /** Decrypt forwardOf from DB; null/empty stays undefined (legacy Notes rows). */
  private async decryptForwardOf(
    stored: string | null | undefined
  ): Promise<Message['forwardOf']> {
    if (!stored) return undefined;
    try {
      const json = await this.decryptContent(stored);
      return this.deserializeForwardOf(json);
    } catch {
      return undefined;
    }
  }

  /** Get a self-message by DB id with decrypted content. */
  async get(id: number): Promise<Message | undefined> {
    const row = await this.queries.messages.getById(id);
    if (!row || row.contactUserId !== SELF_CONTACT_ID) return undefined;
    try {
      const plaintext = await this.decryptContent(row.content);
      return {
        id: row.id,
        ownerUserId: row.ownerUserId,
        contactUserId: row.contactUserId,
        content: plaintext,
        type: row.type,
        direction: MessageDirection.OUTGOING,
        status: row.status,
        timestamp: row.timestamp,
        forwardOf: await this.decryptForwardOf(row.forwardOf as string | null),
        metadata: row.metadata
          ? (JSON.parse(row.metadata as string) as Record<string, unknown>)
          : undefined,
      };
    } catch {
      return undefined;
    }
  }

  async send(
    content: string,
    options?: { forwardOf?: Message['forwardOf'] }
  ): Promise<Message> {
    const encryptedContent = await this.encryptContent(content);
    const now = new Date();
    const forwardOf = options?.forwardOf;
    const encryptedForwardOf = await this.encryptForwardOf(forwardOf);

    const id = await this.queries.messages.insert({
      ownerUserId: this.ownerUserId,
      contactUserId: SELF_CONTACT_ID,
      content: encryptedContent,
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: now,
      forwardOf: encryptedForwardOf,
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
      ownerUserId: this.ownerUserId,
      contactUserId: SELF_CONTACT_ID,
      content,
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: now,
      forwardOf,
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
          ownerUserId: row.ownerUserId,
          contactUserId: row.contactUserId,
          content: plaintext,
          type: row.type,
          direction: MessageDirection.OUTGOING,
          status: row.status,
          timestamp: row.timestamp,
          forwardOf: await this.decryptForwardOf(
            row.forwardOf as string | null
          ),
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

    await this.queries.messages.updateById(id, {
      content: encryptedContent,
      metadata: JSON.stringify({ ...existingMetadata, edited: true }),
    });
  }

  async deleteMessage(id: number): Promise<void> {
    // Delete any reactions that reference this message via metadata.originalMessageId
    const reactions = await this.queries.messages.getReactionsByOwnerAndContact(
      this.ownerUserId,
      SELF_CONTACT_ID
    );

    const toDelete = reactions.filter(row => {
      if (!row.metadata) return false;
      try {
        const meta = JSON.parse(row.metadata as string);
        return meta?.originalMessageId === id;
      } catch {
        return false;
      }
    });

    for (const reaction of toDelete) {
      await this.queries.messages.deleteById(reaction.id);
    }

    await this.queries.messages.deleteById(id);
  }

  async sendReaction(
    emoji: string,
    originalMessageDbId: number
  ): Promise<{ id: number; emoji: string; originalMessageId: number }> {
    const encryptedEmoji = await this.encryptContent(emoji);
    const now = new Date();

    const id = await this.queries.messages.insert({
      ownerUserId: this.ownerUserId,
      contactUserId: SELF_CONTACT_ID,
      content: encryptedEmoji,
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
        const emoji = await this.decryptContent(row.content);
        const meta = row.metadata ? JSON.parse(row.metadata as string) : null;
        const originalMessageId = meta?.originalMessageId;
        if (typeof originalMessageId === 'number') {
          result.push({ id: row.id, emoji, originalMessageId });
        }
      } catch {
        // Skip reactions that cannot be decrypted
      }
    }

    return result;
  }
}
