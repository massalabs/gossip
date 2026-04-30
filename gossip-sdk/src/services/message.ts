/**
 * Message Reception Service
 *
 * Handles fetching encrypted messages from the protocol and decrypting them.
 * This service works both in host app contexts and SDK/automation context.
 */

import {
  type Message,
  MessageDirection,
  MessageStatus,
  MessageType,
  MESSAGE_ID_SIZE,
} from '../db/index.js';
import { type MessageRow } from '../db/index.js';
import { decodeUserId, encodeUserId } from '../utils/userId.js';
import {
  IMessageProtocol,
  EncryptedMessage,
} from '../api/messageProtocol/index.js';
import { SessionStatus } from '../wasm/bindings.js';
import { SessionModule } from '../wasm/index.js';
import {
  serializeRegularMessage,
  serializeReplyMessage,
  serializeForwardMessage,
  serializeKeepAliveMessage,
  serializeDeleteMessage,
  serializeEditMessage,
  serializeReactionMessage,
  serializeRetentionPolicyMessage,
  deserializeMessage,
} from '../utils/messageSerialization.js';
import * as schema from '../db/schema/index.js';
import { encodeToBase64, decodeFromBase64 } from '../utils/base64.js';
import { Result } from '../utils/type.js';
import { sessionStatusToString } from '../wasm/session.js';
import { Logger } from '../utils/logs.js';
import { SdkConfig, defaultSdkConfig } from '../config/sdk.js';
import { SdkEventEmitter, SdkEventType } from '../core/SdkEventEmitter.js';
import { Queries } from '../db/queries/index.js';
import { QueueManager } from '../utils/queue.js';
import { and, eq, sql } from 'drizzle-orm';
import { GossipSqliteTx } from '../db/sqlite.js';
import { POST_MESSAGE_TYPES } from '../utils/message.js';

/** Options for the simplified sendText method */
export interface SendTextOptions {
  /** Reply to an existing message */
  replyTo?: { originalMsgId: Uint8Array };
  /** Arbitrary metadata to attach */
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// JSON serialization helpers for message fields stored as text in SQLite
// ---------------------------------------------------------------------------

/** Serialize replyTo to JSON string for SQLite storage.
 *  Uint8Array fields are base64-encoded. */
function serializeReplyTo(
  replyTo: { originalMsgId: Uint8Array } | undefined
): string | null {
  if (!replyTo) return null;
  return JSON.stringify({
    originalMsgId: encodeToBase64(replyTo.originalMsgId),
  });
}

/** Deserialize replyTo from JSON string. */
function deserializeReplyTo(
  json: string | null
): { originalMsgId: Uint8Array } | undefined {
  if (!json) return undefined;
  const parsed = JSON.parse(json);
  return {
    originalMsgId: decodeFromBase64(parsed.originalMsgId),
  };
}

/** Serialize forwardOf to JSON string for SQLite storage. */
function serializeForwardOf(
  forwardOf:
    | { originalContent?: string; originalContactId?: Uint8Array }
    | undefined
): string | null {
  if (!forwardOf) return null;
  return JSON.stringify({
    originalContent: forwardOf.originalContent,
    originalContactId: forwardOf.originalContactId
      ? encodeToBase64(forwardOf.originalContactId)
      : undefined,
  });
}

/** Deserialize forwardOf from JSON string. */
function deserializeForwardOf(
  json: string | null
): { originalContent?: string; originalContactId?: Uint8Array } | undefined {
  if (!json) return undefined;
  const parsed = JSON.parse(json);
  return {
    originalContent: parsed.originalContent ?? undefined,
    originalContactId: parsed.originalContactId
      ? decodeFromBase64(parsed.originalContactId)
      : undefined,
  };
}

/** Serialize deleteOf to JSON string for SQLite storage. */
function serializeDeleteOf(
  deleteOf: { originalMsgId: Uint8Array } | undefined
): string | null {
  if (!deleteOf) return null;
  return JSON.stringify({
    originalMsgId: encodeToBase64(deleteOf.originalMsgId),
  });
}

/** Deserialize deleteOf from JSON string. */
function deserializeDeleteOf(
  json: string | null
): { originalMsgId: Uint8Array } | undefined {
  if (!json) return undefined;
  const parsed = JSON.parse(json);
  return {
    originalMsgId: decodeFromBase64(parsed.originalMsgId),
  };
}

function serializeEditOf(
  editOf: { originalMsgId: Uint8Array } | undefined
): string | null {
  if (!editOf) return null;
  return JSON.stringify({
    originalMsgId: encodeToBase64(editOf.originalMsgId),
  });
}

function deserializeEditOf(
  json: string | null
): { originalMsgId: Uint8Array } | undefined {
  if (!json) return undefined;
  const parsed = JSON.parse(json);
  return {
    originalMsgId: decodeFromBase64(parsed.originalMsgId),
  };
}

function serializeReactionOf(
  reactionOf: { originalMsgId: Uint8Array } | undefined
): string | null {
  if (!reactionOf) return null;
  return JSON.stringify({
    originalMsgId: encodeToBase64(reactionOf.originalMsgId),
  });
}

function deserializeReactionOf(
  json: string | null
): { originalMsgId: Uint8Array } | undefined {
  if (!json) return undefined;
  const parsed = JSON.parse(json);
  return {
    originalMsgId: decodeFromBase64(parsed.originalMsgId),
  };
}

/** Serialize metadata to JSON string. */
function serializeMetadata(
  metadata: Record<string, unknown> | undefined
): string | null {
  if (!metadata) return null;
  return JSON.stringify(metadata);
}

/** Deserialize metadata from JSON string. */
function deserializeMetadata(
  json: string | null
): Record<string, unknown> | undefined {
  if (!json) return undefined;
  return JSON.parse(json);
}

/** Convert a SQLite row from the messages table to a Message object. */
export function rowToMessage(row: MessageRow): Message {
  return {
    id: row.id,
    messageId: row.messageId ?? undefined,
    ownerUserId: row.ownerUserId,
    contactUserId: row.contactUserId,
    content: row.content,
    serializedContent: row.serializedContent ?? undefined,
    type: row.type as MessageType,
    direction: row.direction as MessageDirection,
    status: row.status as MessageStatus,
    timestamp: row.timestamp,
    metadata: deserializeMetadata(row.metadata),
    seeker: row.seeker ?? undefined,
    replyTo: deserializeReplyTo(row.replyTo),
    forwardOf: deserializeForwardOf(row.forwardOf),
    deleteOf: deserializeDeleteOf(row.deleteOf ?? null),
    editOf: deserializeEditOf(row.editOf ?? null),
    reactionOf: deserializeReactionOf(row.reactionOf ?? null),
    encryptedMessage: row.encryptedMessage ?? undefined,
    whenToSend: row.whenToSend ?? undefined,
  };
}

export interface MessageResult {
  success: boolean;
  newMessagesCount: number;
  error?: string;
}

export interface SendMessageResult {
  success: boolean;
  message?: Message;
  error?: string;
}

interface Decrypted {
  content: string;
  sentAt: Date;
  senderId: string;
  seeker: Uint8Array;
  messageId: Uint8Array; // 12-byte random ID
  replyTo?: {
    originalMsgId: Uint8Array;
  };
  forwardOf?: {
    originalContent: string;
    originalContactId?: Uint8Array;
  };
  deleteOf?: {
    originalMsgId: Uint8Array;
  };
  editOf?: {
    originalMsgId: Uint8Array;
  };
  reactionOf?: {
    originalMsgId: Uint8Array;
  };
  encryptedMessage: Uint8Array;
  type: MessageType;
}

const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

const logger = new Logger('MessageService');
export class MessageService {
  private messageProtocol: IMessageProtocol;
  private session: SessionModule;
  private eventEmitter: SdkEventEmitter;
  private config: SdkConfig;
  private queueManager?: QueueManager;
  private processingContacts = new Set<string>();
  private isFetchingMessages = false;
  private queries: Queries;
  /**
   * Message ids currently being sent via `sendMessageFastPath`. The row is
   * WAITING_SESSION in the DB while the fast path runs INSERT + encrypt +
   * POST in parallel. Without this guard, a concurrent `stateUpdate` could
   * pick up the same WAITING_SESSION row via `processSendQueueForContact`
   * and send a duplicate.
   */
  private inFlightFastPath = new Set<number>();
  /**
   * Force-fire the SDK's pending session-blob persist. Wired by
   * `GossipSdk.openSession` via `setPersistFlusher`. Used by the send
   * hot path to run persist in parallel with the network write so the
   * PQ counter is durable on disk before the relay confirms receipt
   * (otherwise a crash between encrypt and the next debounced flush
   * would leak an advanced in-RAM counter, leading to a re-used
   * counter on the next send → peer collision).
   *
   * No-op (`async () => {}`) until the SDK calls the setter, which
   * keeps unit tests of MessageService that don't bring up the full
   * SDK working without extra plumbing.
   */
  private persistFlusher: () => Promise<void> = async () => {};

  setPersistFlusher(flusher: () => Promise<void>): void {
    this.persistFlusher = flusher;
  }

  /** Emit MESSAGE_RECEIVED with a Message that may not have a DB id yet */
  private emitMessageReceived(
    message: Omit<Message, 'id'> & { id?: number }
  ): void {
    this.eventEmitter.emit(SdkEventType.MESSAGE_RECEIVED, message);
  }

  constructor(
    messageProtocol: IMessageProtocol,
    session: SessionModule,
    eventEmitter: SdkEventEmitter,
    config: SdkConfig = defaultSdkConfig,
    queries: Queries
  ) {
    this.messageProtocol = messageProtocol;
    this.session = session;
    this.eventEmitter = eventEmitter;
    this.config = config;
    this.queries = queries;
  }

  setQueueManager(queueManager: QueueManager): void {
    this.queueManager = queueManager;
  }

  async fetchMessages(): Promise<MessageResult> {
    const log = logger.forMethod('fetchMessages');

    if (this.isFetchingMessages) {
      log.info('fetch already in progress, skipping');
      return { success: true, newMessagesCount: 0 };
    }

    this.isFetchingMessages = true;
    try {
      if (!this.session) throw new Error('Session module not initialized');

      let previousSeekers = new Set<string>();
      let iterations = 0;
      let newMessagesCount = 0;
      let seekers: Uint8Array[] = [];

      while (true) {
        seekers = this.session.getMessageBoardReadKeys();
        if (seekers.length === 0) return { success: true, newMessagesCount: 0 };

        const currentSeekers = new Set(seekers.map(s => encodeToBase64(s)));

        const allSame =
          seekers.length === previousSeekers.size &&
          [...currentSeekers].every(s => previousSeekers.has(s));

        const maxIterations = this.config.messages.maxFetchIterations;
        if (allSame || iterations >= maxIterations) {
          if (iterations >= maxIterations) {
            log.warn('fetch loop stopped due to max iterations', {
              iterations,
              maxIterations,
            });
          }
          break;
        }

        const encryptedMessages =
          await this.messageProtocol.fetchMessages(seekers);
        previousSeekers = currentSeekers;

        if (encryptedMessages.length === 0) {
          iterations++;
          await sleep(this.config.messages.fetchDelayMs);
          continue;
        }

        const { decrypted: decryptedMessages, acknowledgedSeekers } =
          await this.decryptMessages(encryptedMessages);
        if (decryptedMessages.length > 0) {
          const storedIds = await this.storeDecryptedMessages(
            decryptedMessages,
            this.session.userIdEncoded
          );
          newMessagesCount += storedIds.length;
        }

        log.info('acknowledged seekers', {
          acknowledgedSeekers: Array.from(acknowledgedSeekers),
        });

        if (acknowledgedSeekers.size > 0) {
          log.info('processing acknowledged seekers', {
            count: acknowledgedSeekers.size,
          });
          await this.acknowledgeMessages(
            acknowledgedSeekers,
            this.session.userIdEncoded
          );
        }

        iterations++;
        await sleep(this.config.messages.fetchDelayMs);
      }

      try {
        // Clone the seekers' bytes before passing them to `replaceAll`.
        // Background: on the secure-storage WASM-worker path, SQL bind
        // params (including these Uint8Array seekers) cross the Comlink
        // boundary via `Comlink.transfer(params, transfers)` — that
        // marks each underlying ArrayBuffer as transferable, which
        // moves ownership to the worker and *detaches* the views on
        // this side. Subsequent access (`Array.from(s)` in the
        // SEEKERS_UPDATED listener at `services/index.ts`) throws
        // "Cannot perform values on a detached or out-of-bounds
        // ArrayBuffer". Cloning into fresh JS-owned buffers before the
        // transfer keeps a usable copy here for the event emit.
        //
        // `new Uint8Array(srcTypedArray)` allocates a new ArrayBuffer
        // and copies the bytes — guaranteed independent of the source.
        const seekersForEvent = seekers.map(s => new Uint8Array(s));
        await this.queries.activeSeekers.replaceAll(seekers);
        this.eventEmitter.emit(SdkEventType.SEEKERS_UPDATED, seekersForEvent);
      } catch (error) {
        log.error('failed to update active seekers', error);
      }

      if (newMessagesCount > 0) {
        log.info(`fetch completed — ${newMessagesCount} new messages received`);
      }

      return { success: true, newMessagesCount };
    } catch (err) {
      log.error('fetch failed', err);
      return {
        success: false,
        newMessagesCount: 0,
        error: err instanceof Error ? err.message : 'Unknown error',
      };
    } finally {
      this.isFetchingMessages = false;
    }
  }

  /**
   * Add a message to SQLite and update the corresponding discussion.
   */
  private async addMessageAndUpdateDiscussion(
    message: Omit<Message, 'id'>,
    parentTx?: GossipSqliteTx
  ): Promise<number> {
    const result = await (parentTx ?? this.queries.conn.db).transaction(
      async (tx: GossipSqliteTx) => {
        const messageId = await this.queries.messages.insert(
          {
            messageId: message.messageId,
            ownerUserId: message.ownerUserId,
            contactUserId: message.contactUserId,
            content: message.content,
            serializedContent: message.serializedContent,
            type: message.type,
            direction: message.direction,
            status: message.status,
            timestamp: message.timestamp,
            metadata: serializeMetadata(message.metadata),
            seeker: message.seeker,
            replyTo: serializeReplyTo(message.replyTo),
            forwardOf: serializeForwardOf(message.forwardOf),
            deleteOf: serializeDeleteOf(message.deleteOf),
            editOf: serializeEditOf(message.editOf),
            reactionOf: serializeReactionOf(message.reactionOf),
            encryptedMessage: message.encryptedMessage,
            whenToSend: message.whenToSend,
          },
          tx
        );

        const discussion = await this.queries.discussions.getByOwnerAndContact(
          message.ownerUserId,
          message.contactUserId,
          tx
        );

        if (
          discussion &&
          POST_MESSAGE_TYPES.includes(message.type) &&
          !message.editOf
        ) {
          await this.queries.discussions.updateById(
            discussion.id,
            {
              lastMessageId: messageId,
              lastMessageContent: message.content,
              lastMessageTimestamp: message.timestamp,
              updatedAt: new Date(),
            },
            tx
          );

          if (message.direction === MessageDirection.INCOMING) {
            await this.queries.discussions.incrementUnreadCount(
              discussion.id,
              tx
            );
          }

          return { messageId, updatedDiscussionId: discussion?.id };
        }

        return { messageId, updatedDiscussionId: null };
      }
    );

    if (result.updatedDiscussionId && !parentTx) {
      this.eventEmitter.emit(
        SdkEventType.DISCUSSION_UPDATED,
        result.updatedDiscussionId
      );
    }

    return result.messageId;
  }

  private async decryptMessages(encrypted: EncryptedMessage[]): Promise<{
    decrypted: Decrypted[];
    acknowledgedSeekers: Set<string>;
  }> {
    const log = logger.forMethod('decryptMessages');

    const decrypted: Decrypted[] = [];
    const acknowledgedSeekers: Set<string> = new Set();

    for (const msg of encrypted) {
      try {
        const out = await this.session.feedIncomingMessageBoardRead(
          msg.seeker,
          msg.ciphertext
        );
        if (!out) continue;

        try {
          const deserialized = deserializeMessage(out.message);

          out.acknowledged_seekers.forEach((seeker: Uint8Array) =>
            acknowledgedSeekers.add(encodeToBase64(seeker))
          );

          // keep-alive messages are just useful to keep the session alive, we don't need to store them
          if (deserialized.type === MessageType.KEEP_ALIVE) {
            continue;
          }

          // Delete control messages are handled at storage time; keep them in decrypted array

          if (
            !deserialized.messageId ||
            deserialized.messageId.length !== MESSAGE_ID_SIZE
          ) {
            log.warn('missing or invalid messageId, skipping message', {
              messageId: deserialized.messageId,
            });
          }

          decrypted.push({
            content: deserialized.content,
            sentAt: new Date(Number(out.timestamp)),
            senderId: encodeUserId(out.user_id),
            seeker: msg.seeker,
            messageId: deserialized.messageId ?? new Uint8Array(),
            encryptedMessage: msg.ciphertext,
            type: deserialized.type,
            replyTo: deserialized.replyTo,
            forwardOf: deserialized.forwardOf,
            deleteOf: deserialized.deleteOf,
            editOf: deserialized.editOf,
            reactionOf: deserialized.reactionOf,
          });
        } catch (deserializationError) {
          log.error('deserialization failed', {
            error:
              deserializationError instanceof Error
                ? deserializationError.message
                : 'Unknown error',
            seeker: encodeToBase64(msg.seeker),
          });
        }
      } catch (e) {
        log.error('decryption failed', {
          error: e instanceof Error ? e.message : 'Unknown error',
          seeker: encodeToBase64(msg.seeker),
        });
      }
    }

    return { decrypted, acknowledgedSeekers };
  }

  private async storeDecryptedMessages(
    decrypted: Decrypted[],
    ownerUserId: string
  ): Promise<number[]> {
    const log = logger.forMethod('storeDecryptedMessages');

    const storedIds: number[] = [];

    for (const message of decrypted) {
      // Handle delete control messages by updating the referenced message in-place
      if (
        message.type === MessageType.DELETED &&
        message.deleteOf?.originalMsgId
      ) {
        const target = await this.findMessageByMsgId(
          message.deleteOf.originalMsgId,
          ownerUserId,
          message.senderId
        );

        if (!target || !target.id) {
          log.warn('delete target not found', {
            originalMsgId: encodeToBase64(message.deleteOf.originalMsgId),
          });
          continue;
        }

        const resDb = await this.PerformDeleteMessage(target);
        if (!resDb.success) {
          throw new Error(
            resDb.error?.message ?? 'Failed to delete message from db'
          );
        }

        continue;
      }

      // Handle EDIT control messages by updating the referenced message in-place
      if (message.editOf?.originalMsgId) {
        const target = await this.findMessageByMsgId(
          message.editOf.originalMsgId,
          ownerUserId,
          message.senderId
        );

        if (!target || !target.id) {
          log.warn('edit target not found', {
            originalMsgId: encodeToBase64(message.editOf.originalMsgId),
          });
          continue;
        }

        const mergedMetadata = {
          ...(target.metadata ?? {}),
          edited: true,
        };

        // Emit before DB write so UI updates instantly
        this.emitMessageReceived({
          ...target,
          content: message.content,
          metadata: mergedMetadata,
        });

        const res = await this.performEditMessage(
          message.content,
          target,
          mergedMetadata
        );
        if (!res.success) {
          throw new Error(res.error?.message ?? 'Failed to edit message in db');
        }

        // Do not insert a new message row for edit control messages
        continue;
      }

      // Handle retention policy control messages by updating the discussion setting
      if (message.type === MessageType.RETENTION_POLICY) {
        const durationSeconds = parseInt(message.content, 10);
        const duration =
          isNaN(durationSeconds) || durationSeconds <= 0
            ? null
            : durationSeconds;
        await this.queries.discussions.updateByOwnerAndContact(
          ownerUserId,
          message.senderId,
          {
            messageRetentionDuration: duration,
            retentionPolicySetAt: duration ? Date.now() : null,
          }
        );
        const discussion = await this.queries.discussions.getByOwnerAndContact(
          ownerUserId,
          message.senderId
        );
        if (!discussion) {
          this.eventEmitter.emit(SdkEventType.ERROR, {
            error: new Error(
              'could no retrieve discussion after updating retention policy'
            ),
            context: 'storeDecryptedMessages',
          });
          continue;
        }
        this.eventEmitter.emit(SdkEventType.DISCUSSION_UPDATED, discussion.id);
        // Do not insert a new message row for retention policy control messages
        continue;
      }

      // Handle reaction messages by inserting a separate row
      if (
        message.type === MessageType.REACTION &&
        message.reactionOf?.originalMsgId
      ) {
        const discussion = await this.queries.discussions.getByOwnerAndContact(
          ownerUserId,
          message.senderId
        );

        if (!discussion) {
          log.error('no discussion for incoming reaction message', {
            senderId: message.senderId,
            preview: message.content.slice(0, 16),
          });
          continue;
        }

        const id = await this.queries.messages.insert({
          messageId: message.messageId,
          ownerUserId,
          contactUserId: discussion.contactUserId,
          content: message.content,
          type: MessageType.REACTION,
          direction: MessageDirection.INCOMING,
          status: MessageStatus.DELIVERED,
          timestamp: message.sentAt,
          metadata: serializeMetadata({}),
          reactionOf: serializeReactionOf(message.reactionOf),
        });

        this.emitMessageReceived({
          id,
          messageId: message.messageId,
          ownerUserId,
          contactUserId: discussion.contactUserId,
          content: message.content,
          type: MessageType.REACTION,
          direction: MessageDirection.INCOMING,
          status: MessageStatus.DELIVERED,
          timestamp: message.sentAt,
          reactionOf: message.reactionOf,
        });

        storedIds.push(id);
        // Do not update discussion lastMessageContent for reactions
        continue;
      }

      const discussion = await this.queries.discussions.getByOwnerAndContact(
        ownerUserId,
        message.senderId
      );

      if (!discussion) {
        log.error('no discussion for incoming message', {
          senderId: message.senderId,
          preview: message.content.slice(0, 50),
        });
        continue;
      }

      // If received msg has same messageId as a previously received msg
      const isDuplicate = await this.handleDuplicateMessageId(
        message,
        ownerUserId
      );

      if (isDuplicate) {
        log.info('Duplicate message received, skip  ping', {
          senderId: message.senderId,
          preview: message.content.slice(0, 30),
        });
        continue;
      }

      if (message.replyTo?.originalMsgId) {
        const original = await this.findMessageByMsgId(
          message.replyTo.originalMsgId,
          ownerUserId,
          message.senderId
        );
        if (!original) {
          log.warn('reply target not found', {
            originalMsgId: encodeToBase64(message.replyTo.originalMsgId),
          });
        }
      }

      const incomingMsg: Omit<Message, 'id'> = {
        messageId: message.messageId,
        ownerUserId,
        contactUserId: discussion.contactUserId,
        content: message.content,
        type: message.type,
        direction: MessageDirection.INCOMING,
        status: MessageStatus.DELIVERED,
        timestamp: message.sentAt,
        replyTo: message.replyTo,
        forwardOf: message.forwardOf,
      };

      const id = await this.queries.messages.insert({
        messageId: message.messageId,
        ownerUserId,
        contactUserId: discussion.contactUserId,
        content: message.content,
        type: message.type,
        direction: MessageDirection.INCOMING,
        status: MessageStatus.DELIVERED,
        timestamp: message.sentAt,
        metadata: serializeMetadata({}),
        replyTo: serializeReplyTo(message.replyTo),
        forwardOf: serializeForwardOf(message.forwardOf),
      });

      // Update discussion in SQLite
      const now = new Date();
      await this.queries.discussions.updateById(discussion.id, {
        lastMessageId: id,
        lastMessageContent: message.content,
        lastMessageTimestamp: message.sentAt,
        updatedAt: now,
        lastSyncTimestamp: now,
      });
      await this.queries.discussions.incrementUnreadCount(discussion.id);

      storedIds.push(id);

      // Re-emit with DB id so the store patches the optimistic message
      this.emitMessageReceived({ ...incomingMsg, id });
      this.eventEmitter.emit(SdkEventType.DISCUSSION_UPDATED, discussion.id);
    }

    return storedIds;
  }

  /**
   * Checks for duplicate incoming messages based on messageId (12-byte random).
   * Returns true if a message with the same messageId already exists (skips storage).
   */
  private async handleDuplicateMessageId(
    message: Decrypted,
    ownerUserId: string
  ): Promise<boolean> {
    if (message.messageId && message.messageId.length > 0) {
      const existing = await this.queries.messages.findByMessageId(
        ownerUserId,
        message.senderId,
        message.messageId
      );

      if (existing) {
        return true;
      }
    }
    return false;
  }

  async findMessageByMsgId(
    messageId: Uint8Array,
    ownerUserId: string,
    contactUserId?: string
  ): Promise<Message | undefined> {
    if (!contactUserId) {
      return undefined;
    }
    const row = await this.queries.messages.findByMessageId(
      ownerUserId,
      contactUserId,
      messageId
    );
    return row ? rowToMessage(row) : undefined;
  }

  private async acknowledgeMessages(
    seekers: Set<string>,
    userId: string
  ): Promise<void> {
    if (seekers.size === 0) return;

    // Find SENT outgoing messages, then filter by seeker match
    const candidates =
      await this.queries.messages.getOutgoingSentByOwner(userId);

    const toUpdate = candidates.filter(
      m => m.seeker != null && seekers.has(encodeToBase64(m.seeker))
    );

    // Mark matching OUTGOING SENT messages as DELIVERED and clear encrypted data
    for (const m of toUpdate) {
      await this.queries.messages.updateById(m.id, {
        status: MessageStatus.DELIVERED,
        encryptedMessage: null,
        serializedContent: null,
        seeker: null,
        whenToSend: null,
      });
      this.eventEmitter.emit(SdkEventType.MESSAGE_ACKNOWLEDGED, {
        contactUserId: m.contactUserId,
        messageDbId: m.id,
      });
    }

    // After marking as DELIVERED, clean up DELIVERED keep-alive messages
    await this.queries.messages.deleteDeliveredKeepAlive(userId);

    if (toUpdate.length > 0) {
      logger
        .forMethod('acknowledgeMessages')
        .info(`acknowledged ${toUpdate.length} messages`);
    }
  }

  async sendMessage(
    message: Message,
    parentTx?: GossipSqliteTx
  ): Promise<SendMessageResult> {
    const log = logger.forMethod('sendMessage');
    log.info('queueing message', {
      messageType: message.type,
    });

    const peerId = decodeUserId(message.contactUserId);
    if (peerId.length !== 32) {
      return {
        success: false,
        error: 'Invalid contact userId (must be 32 bytes)',
      };
    }

    // Look up discussion
    const discussion = await this.queries.discussions.getByOwnerAndContact(
      message.ownerUserId,
      message.contactUserId,
      parentTx
    );
    if (!discussion) {
      return { success: false, error: 'Discussion not found' };
    }

    // Generate a random messageId for deduplication (not for keep-alive or retention policy)
    // Skip if already provided (e.g., from optimistic send)
    if (!message.messageId) {
      const randomMessageId =
        message.type !== MessageType.KEEP_ALIVE &&
        message.type !== MessageType.RETENTION_POLICY
          ? crypto.getRandomValues(new Uint8Array(MESSAGE_ID_SIZE))
          : undefined;
      message.messageId = randomMessageId;
    }

    let messageIdDb: number;
    try {
      messageIdDb = await this.addMessageAndUpdateDiscussion(
        {
          ...message,
          status: MessageStatus.WAITING_SESSION,
        },
        parentTx
      );
    } catch (error) {
      return {
        success: false,
        error: 'Failed to add message to database, got error: ' + error,
      };
    }

    if (parentTx) {
      // When called inside an existing SQL transaction, avoid lock re-entry
      // (queue processing + plain read paths run through conn.db/execRaw queue).
      return {
        success: true,
        message: {
          ...message,
          id: messageIdDb,
        },
      };
    }

    /*
    Trigger a sending queue state update for contact in order to send the new message.
    If the processSendQueueForContact function is already running, it will be skipped.
    */
    await this.processSendQueueForContact(message.contactUserId);

    const messageDb = await this.queries.messages.getById(messageIdDb);
    if (!messageDb) {
      return {
        success: false,
        error: 'Could not retrieve message after adding it to the database',
      };
    }

    return {
      success: true,
      message: rowToMessage(messageDb),
    };
  }

  private async serializeMessage(
    message: Message
  ): Promise<Result<Uint8Array, string>> {
    const log = logger.forMethod('serializeMessage');

    if (
      !message.messageId &&
      message.type !== MessageType.KEEP_ALIVE &&
      message.type !== MessageType.RETENTION_POLICY
    ) {
      return {
        success: false,
        error: 'Message ID is required',
      };
    }

    if (message.replyTo) {
      const originalMessage = await this.findMessageByMsgId(
        message.replyTo.originalMsgId,
        message.ownerUserId,
        message.contactUserId
      );

      if (!originalMessage) {
        return {
          success: false,
          error: 'Original message not found for reply',
        };
      }

      return {
        success: true,
        data: serializeReplyMessage(
          message.content,
          message.replyTo.originalMsgId,
          message.messageId!
        ),
      };
    } else if (message.type === MessageType.KEEP_ALIVE) {
      return {
        success: true,
        data: serializeKeepAliveMessage(),
      };
    } else if (message.type === MessageType.RETENTION_POLICY) {
      const durationSeconds = parseInt(message.content, 10);
      return {
        success: true,
        data: serializeRetentionPolicyMessage(
          isNaN(durationSeconds) || durationSeconds < 0 ? 0 : durationSeconds
        ),
      };
    } else if (message.type === MessageType.DELETED && message.deleteOf) {
      // Serialize a delete control message targeting an existing messageId
      const originalMsgId = message.deleteOf.originalMsgId;
      if (!originalMsgId || originalMsgId.length !== MESSAGE_ID_SIZE) {
        return {
          success: false,
          error: 'Original messageId is required for delete messages',
        };
      }
      return {
        success: true,
        data: serializeDeleteMessage(originalMsgId, message.messageId!),
      };
    } else if (message.editOf) {
      const originalMsgId = message.editOf.originalMsgId;
      if (!originalMsgId || originalMsgId.length !== MESSAGE_ID_SIZE) {
        return {
          success: false,
          error: 'Original messageId is required for edit messages',
        };
      }

      return {
        success: true,
        data: serializeEditMessage(
          message.content,
          originalMsgId,
          message.messageId!
        ),
      };
    } else if (message.forwardOf) {
      try {
        return {
          success: true,
          data: serializeForwardMessage(
            message.forwardOf.originalContent ?? '',
            message.content,
            message.messageId!,
            message.forwardOf.originalContactId
          ),
        };
      } catch (error) {
        log.error('failed to serialize forward message', error);
        return {
          success: false,
          error: 'Failed to serialize forward message',
        };
      }
    } else if (message.type === MessageType.REACTION && message.reactionOf) {
      const originalMsgId = message.reactionOf.originalMsgId;
      if (!originalMsgId || originalMsgId.length !== MESSAGE_ID_SIZE) {
        return {
          success: false,
          error: 'Original messageId is required for reaction messages',
        };
      }

      return {
        success: true,
        data: serializeReactionMessage(
          message.content,
          originalMsgId,
          message.messageId!
        ),
      };
    } else {
      // Regular message with type tag
      return {
        success: true,
        data: serializeRegularMessage(message.content, message.messageId!),
      };
    }
  }

  /**
   * Process the send queue for a single contact.
   * Handles WAITING_SESSION -> READY encryption and READY -> SENT delivery.
   */
  async processSendQueueForContact(
    contactUserId: string
  ): Promise<Result<number, Error>> {
    const log = logger.forMethod('processSendQueueForContact');
    const ownerUserId = this.session.userIdEncoded;

    if (this.processingContacts.has(contactUserId)) {
      log.info('send queue already processing, skipping', { contactUserId });
      return { success: true, data: 0 };
    }

    this.processingContacts.add(contactUserId);
    try {
      const discussion = await this.queries.discussions.getByOwnerAndContact(
        ownerUserId,
        contactUserId
      );
      const weAccepted = discussion?.weAccepted;
      if (!discussion || !weAccepted) {
        return {
          success: false,
          error: new Error(
            'Discussion not found or we did not accept the discussion'
          ),
        };
      }

      const peerId = decodeUserId(contactUserId);
      const sessionStatus = this.session.peerSessionStatus(peerId);
      if (
        ![
          SessionStatus.Active,
          // saturated sessions can't send messages on session manager but it's still possible to send on network msg that have already been encrypted if any
          SessionStatus.Saturated,
        ].includes(sessionStatus)
      ) {
        log.info('session neither active nor saturated, skipping send queue', {
          contactUserId,
          sessionStatus: sessionStatusToString(sessionStatus),
        });
        return {
          success: false,
          error: new Error('Session neither active nor saturated'),
        };
      }

      // retrieve all messages in send queue that need to be updated for this contact
      const pendingMessages = (
        await this.queries.messages.getSendQueue(ownerUserId, contactUserId)
      ).map(rowToMessage);

      log.debug('pending messages', {
        pendingMessages: pendingMessages.map(msg => ({
          id: msg.id,
          status: msg.status,
          timestamp: msg.timestamp,
          content: msg.content,
          type: msg.type,
          direction: msg.direction,
        })),
      });

      if (pendingMessages.length === 0) {
        return { success: true, data: 0 };
      }

      let sentCount = 0;

      for (const msg of pendingMessages) {
        if (!msg.id) continue;
        if (this.inFlightFastPath.has(msg.id)) continue;

        const currentStatus = msg.status;
        let encryptedMessage = msg.encryptedMessage;
        let seeker = msg.seeker;
        const whenToSend = msg.whenToSend;

        // Happy path: WAITING_SESSION + Active session.
        // Encrypt → network → SENT directly, skipping the intermediate
        // READY SQL write. The READY block below still handles retries
        // (delayed sends, post-failure retries), where the encrypted
        // bytes need to survive a restart.
        if (
          currentStatus === MessageStatus.WAITING_SESSION &&
          sessionStatus === SessionStatus.Active
        ) {
          let serializedContent = msg.serializedContent;
          if (!serializedContent) {
            const serializeResult = await this.serializeMessage(msg);
            if (!serializeResult.success) {
              log.error('failed to serialize queued message', {
                messageId: msg.id,
                error: serializeResult.error,
              });
              continue;
            }
            serializedContent = serializeResult.data;
          }

          /* Encrypt message*/
          const sendOutput = await this.session.sendMessage(
            peerId,
            serializedContent
          );
          if (!sendOutput) {
            log.info(
              'session manager returned null for queued message; will retry later',
              {
                messageId: msg.id,
              }
            );
            // Treat as transient and keep message in WAITING_SESSION.
            continue;
          }

          encryptedMessage = sendOutput.data;
          seeker = sendOutput.seeker;

          // Run persist and the wire write in PARALLEL.
          //
          // The encrypt above advanced the PQ session counter in RAM.
          // Persist must capture that mutation durably, but it does
          // NOT depend on the network result, and the network
          // publish only needs the (seeker, ciphertext) pair — also
          // independent of persist. Awaiting them sequentially
          // (persist → network) costs `persist + network` (≈ 500 ms
          // on Android); awaiting them in parallel costs
          // `max(persist, network)` (≈ 350 ms — persist hides under
          // the network round-trip).
          //
          // Crash-safety analysis (verified against the gossip
          // session manager in `wasm/sessions/src/session_manager.rs`
          // and `session.rs`):
          //   - Window where network landed but persist did NOT:
          //     B has advanced its peer-ratchet to the next expected
          //     seeker. On A's restart, state is restored to the
          //     pre-crash counter. A's send loop re-runs the row
          //     (still WAITING_SESSION) and re-encrypts with the
          //     OLD counter → produces a seeker B no longer expects
          //     → B's `feed_incoming_message_board_read` finds no
          //     matching peer and silently ignores the duplicate.
          //     **No session kill.** The session-close branch in
          //     `session_manager.rs:642` only fires after a peer is
          //     matched AND `try_feed_incoming_message` returns None
          //     (decrypt failure on a matched session) — neither
          //     condition is met for a stale-seeker retry.
          //   - Side-effect: A's row stays WAITING_SESSION and is
          //     retried on every session refresh. The `acknowledged
          //     _seekers` field of the next message B sends back
          //     to A includes the seeker A originally published
          //     (which B did receive successfully), and A's send
          //     loop uses that to mark the row SENT and stop
          //     retrying. So the "stuck retry" is self-healing as
          //     soon as the conversation has any back-traffic.
          //
          // Promise.all rejects on either failure:
          //   - Network failed → caught below, row → READY with
          //     ciphertext kept (avoids re-encrypt on retry).
          //   - Persist failed → bubbles up, row stays
          //     WAITING_SESSION (no SENT update). The next session
          //     activation re-runs the loop.
          try {
            await Promise.all([
              this.messageProtocol.sendMessage({
                seeker,
                ciphertext: encryptedMessage,
              }),
              this.persistFlusher(),
            ]);
          } catch (error) {
            log.error('network send failed for fresh message', {
              messageId: msg.id,
              error,
            });
            await this.queries.messages.updateById(msg.id, {
              status: MessageStatus.READY,
              encryptedMessage,
              seeker,
              whenToSend: new Date(
                Date.now() + this.config.messages.retryDelayMs
              ),
              serializedContent,
            });
            continue;
          }

          // Network success. Race-check: most resets only touch
          // READY/SENT rows so they leave us alone, but the discussion
          // could have been deleted while we were on the wire — bail
          // out if the row is gone or has moved to a non-WAITING state.
          const latestRow = await this.queries.messages.getById(msg.id);
          if (
            !latestRow ||
            latestRow.status !== MessageStatus.WAITING_SESSION
          ) {
            log.debug(
              'message gone or status changed during network send, skipping SENT update',
              {
                messageId: msg.id,
                currentStatus: latestRow?.status,
              }
            );
            continue;
          }

          // Network success. Emit MESSAGE_SENT and bump counters
          // BEFORE awaiting the SQL UPDATE so the UI flips to ✓ as
          // soon as the wire write returns (saves ~150 ms of
          // encrypted-VFS commit on the user-perceived path). The
          // UPDATE itself fires in the background through the same
          // runTransaction queue as everything else, so subsequent
          // sends still see ordered persistence.
          //
          // TODO check: duplicate-send risk on crash.
          //   - If the process dies between network success and the
          //     async UPDATE landing, the row stays WAITING_SESSION.
          //     At next boot `processSendQueueForContact` will pick
          //     it up, re-encrypt (advancing the PQ counter) and
          //     re-send. The peer should dedupe on `seeker` (each
          //     message has a unique seeker bound to the original
          //     ciphertext) — VERIFY relay/peer dedup behaviour and
          //     decide whether the dup-window is acceptable for
          //     the protocol's `messageId` semantics.
          //
          // TODO check: race against external row resetters.
          //   - The `latestRow.status !== WAITING_SESSION` guard
          //     above protects against another flow flipping the
          //     row mid-send, but only at the moment of the check.
          //     If a reset path runs AFTER we read but BEFORE the
          //     async UPDATE lands, we'd overwrite their reset
          //     with SENT. Today no SDK code path resets a SENT
          //     row, so the race is theoretical — but if a future
          //     "delete account" or "wipe history" flow targets
          //     SENT rows, revisit this.
          //
          // TODO check: ordering with subsequent sends.
          //   - The fire-and-forget UPDATE goes through the same
          //     runTransaction queue, so a follow-up send's
          //     addMessage waits for it implicitly. That preserves
          //     "row exists before next op" but means the gain is
          //     mostly in tap-to-sent perception, not raw
          //     throughput on rapid bursts.
          sentCount++;
          log.debug('message sent (skipped READY)', {
            messageId: msg.id,
            status: MessageStatus.SENT,
            content: msg.content,
            type: msg.type,
            direction: msg.direction,
          });
          const isControlMessage = !!(msg.deleteOf || msg.editOf);
          if (!isControlMessage) {
            try {
              this.eventEmitter.emit(SdkEventType.MESSAGE_SENT, {
                ...msg,
                status: MessageStatus.SENT,
              });
            } catch (error) {
              log.error('failed to emit message sent event', {
                messageId: msg.id,
                error,
              });
            }
          }

          // Fire-and-forget persistence. Failures are logged but
          // never abort the send — the message is already on the
          // relay; locally retrying the UPDATE on the next tick is
          // safe because runTransaction serialises ordering.
          const msgId = msg.id;
          void this.queries.messages
            .updateById(msgId!, {
              status: MessageStatus.SENT,
              seeker,
              encryptedMessage: null,
              serializedContent: null,
              whenToSend: null,
            })
            .catch(error => {
              log.error(
                'background SENT-status persist failed (message is on relay; will retry on next session activation)',
                { messageId: msgId, error }
              );
            });
          continue;
        }

        if (currentStatus === MessageStatus.READY) {
          const sendAt = whenToSend ?? new Date();
          if (sendAt.getTime() > Date.now()) {
            log.debug('message not ready to send, skipping', {
              messageId: msg.id,
              status: currentStatus,
              content: msg.content,
              type: msg.type,
              direction: msg.direction,
              whenToSend: sendAt,
            });
            continue;
          }

          if (!encryptedMessage || !seeker) {
            await this.queries.messages.updateById(msg.id, {
              status: MessageStatus.WAITING_SESSION,
              encryptedMessage: null,
              seeker: null,
              whenToSend: null,
            });
            log.debug(
              'message has no encryptedMessage or seeker, updated to WAITING_SESSION',
              {
                messageId: msg.id,
                status: currentStatus,
                content: msg.content,
                type: msg.type,
                direction: msg.direction,
                whenToSend: whenToSend,
                encryptedMessage: encryptedMessage,
                seeker: seeker,
              }
            );
            continue;
          }

          /* Sending on network */
          try {
            await this.messageProtocol.sendMessage({
              seeker,
              ciphertext: encryptedMessage,
            });

            // update the db — check latest state to avoid race conditions
            const latestRow = await this.queries.messages.getById(msg.id);

            let sent = false;
            if (
              latestRow && // ensure the discussion has not been deleted
              latestRow.status === MessageStatus.READY // ensure the discussion has not been reset with all pending messages reset to WAITING_SESSION
            ) {
              await this.queries.messages.updateById(msg.id, {
                status: MessageStatus.SENT,
                encryptedMessage: null,
                serializedContent: null,
                whenToSend: null,
              });
              sent = true;
            }

            if (sent) {
              sentCount++;
              log.debug('message sent', {
                messageId: msg.id,
                status: MessageStatus.SENT,
                content: msg.content,
                type: msg.type,
                direction: msg.direction,
              });
              // Skip emitting MESSAGE_SENT for control messages (delete/edit).
              // These are internal transport details; the semantic optimistic
              // events already handle UI state.
              const isControlMessage = !!(msg.deleteOf || msg.editOf);
              if (!isControlMessage) {
                try {
                  this.eventEmitter.emit(SdkEventType.MESSAGE_SENT, {
                    ...msg,
                    status: MessageStatus.SENT,
                  });
                } catch (error) {
                  log.error('failed to emit message sent event', {
                    messageId: msg.id,
                    error,
                  });
                }
              }
            }
          } catch (error) {
            log.error('network send failed for queued message', {
              messageId: msg.id,
              error,
            });
            const latestRow = await this.queries.messages.getById(msg.id);
            if (
              latestRow && // ensure the discussion has not been deleted
              latestRow.status === MessageStatus.READY // ensure the discussion has not been reset with all pending messages reset to WAITING_SESSION
            ) {
              await this.queries.messages.updateById(msg.id, {
                whenToSend: new Date(
                  Date.now() + this.config.messages.retryDelayMs
                ),
              });
            }
          }
        }
      }

      return { success: true, data: sentCount };
    } finally {
      this.processingContacts.delete(contactUserId);
    }
  }

  /**
   * Count pending outgoing messages for a contact (WAITING_SESSION/READY).
   */
  async getPendingSendCount(contactUserId: string): Promise<number> {
    const ownerUserId = this.session.userIdEncoded;
    const rows = await this.queries.messages.getSendQueue(
      ownerUserId,
      contactUserId
    );
    return rows.length;
  }

  // ─────────────────────────────────────────────────────────────────
  // Consumer-facing convenience methods
  // ─────────────────────────────────────────────────────────────────

  /** Get a message by its database ID */
  async get(id: number): Promise<Message | undefined> {
    const row = await this.queries.messages.getById(id);
    return row ? rowToMessage(row) : undefined;
  }

  /** Get all messages for a contact (using session owner).
   *  NOTE: This returns raw rows without UI-level filtering.
   */
  async getMessages(contactUserId: string): Promise<Message[]> {
    const rows = await this.queries.messages.getByOwnerAndContact(
      this.session.userIdEncoded,
      contactUserId
    );
    return rows.map(rowToMessage);
  }

  /** Get only user-visible messages for a contact (filtered + ordered). */
  async getVisibleMessages(contactUserId: string): Promise<Message[]> {
    const rows = await this.queries.messages.getVisibleByOwnerAndContact(
      this.session.userIdEncoded,
      contactUserId
    );
    return rows.map(rowToMessage);
  }

  /** Get all non-deleted reaction messages for a contact. */
  async getReactions(contactUserId: string): Promise<Message[]> {
    const rows = await this.queries.messages.getReactionsByOwnerAndContact(
      this.session.userIdEncoded,
      contactUserId
    );
    return rows.map(rowToMessage);
  }

  /** Send a message and await the full DB write + queue pipeline. */
  async send(message: Omit<Message, 'id'>): Promise<SendMessageResult> {
    if (this.queueManager) {
      return this.queueManager.enqueue(message.contactUserId, () =>
        this.sendMessage(message)
      );
    }
    return this.sendMessage(message);
  }

  /**
   * Send a text message (simplified).
   * Builds the Message internally, sends it via queue, and triggers state update.
   */
  async sendText(
    contactUserId: string,
    text: string,
    options?: SendTextOptions
  ): Promise<SendMessageResult> {
    const message: Omit<Message, 'id'> = {
      ownerUserId: this.session.userIdEncoded,
      contactUserId,
      content: text,
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.WAITING_SESSION,
      timestamp: new Date(),
      ...(options?.replyTo && { replyTo: options.replyTo }),
      ...(options?.metadata && { metadata: options.metadata }),
    };
    const result = await this.send(message);
    return result;
  }

  /** Fetch and decrypt messages from the protocol (alias) */
  async fetch(): Promise<MessageResult> {
    return this.fetchMessages();
  }

  private async PerformDeleteMessage(
    message: Message,
    parentTx?: GossipSqliteTx
  ): Promise<Result<(() => void) | null, Error>> {
    if (!message.id) {
      return { success: false, error: new Error('Message ID is required') };
    }
    if (message.type === MessageType.REACTION) {
      // Reaction delete: hard-delete the row, not "[Message deleted]"
      try {
        await this.queries.messages.deleteById(message.id, parentTx);
        return {
          success: true,
          data: () => {
            this.eventEmitter.emit(SdkEventType.MESSAGE_DELETED, {
              messages: [message],
            });
          },
        };
      } catch (error) {
        return {
          success: false,
          error:
            error instanceof Error
              ? error
              : new Error(
                  'Unknown error occurred while deleting reaction message'
                ),
        };
      }
    }

    let deletedMessages: Message[] = [];
    let updatedMessages: Message[] = [];
    let discussionUpdated = false;
    const discussion = await this.queries.discussions.getByOwnerAndContact(
      message.ownerUserId,
      message.contactUserId,
      parentTx
    );
    if (!discussion) {
      return { success: false, error: new Error('Discussion not found') };
    }

    await (parentTx ?? this.queries.conn.db).transaction(
      async (trx: GossipSqliteTx) => {
        // delete the message : MessageType.DELETED '[Message deleted]' in  db
        await this.queries.messages.updateById(
          message.id!, // message.id is guaranteed to be not null because we checked it above
          {
            content: '[Message deleted]',
            type: MessageType.DELETED,
          },
          trx
        );

        if (POST_MESSAGE_TYPES.includes(message.type)) {
          // If the message to delete is the last text message in the discussion, update the discussion to the previous last text message
          if (discussion.lastMessageId === message.id) {
            const lastMessage =
              await this.queries.discussions.getLastTextMessage(
                message.contactUserId,
                trx
              );
            await this.queries.discussions.updateById(
              discussion.id,
              {
                lastMessageId: lastMessage?.id ?? null,
                lastMessageContent: lastMessage?.content ?? null,
                lastMessageTimestamp: lastMessage?.timestamp ?? null,
                updatedAt: new Date(),
              },
              trx
            );
            discussionUpdated = true;
          }

          // If deleted message is not read yet, decrement the discussion unread count
          if (
            message.status !== MessageStatus.READ &&
            message.direction === MessageDirection.INCOMING
          ) {
            await this.queries.discussions.decrementUnreadCount(
              discussion.id,
              trx
            );
            discussionUpdated = true;
          }

          // Delete all REACTION messages for this contact referencing this message
          const deletedReactionMessages = await trx
            .delete(schema.messages)
            .where(
              and(
                eq(schema.messages.contactUserId, message.contactUserId),
                eq(schema.messages.type, MessageType.REACTION),
                sql`json_extract(${schema.messages.reactionOf}, '$.originalMsgId') = ${encodeToBase64(message.messageId!)}`
              )
            )
            .returning();
          deletedMessages = deletedReactionMessages.map(rowToMessage);

          // Also update all messages REPLYING to this message by setting their replyTo to null
          const updatedMessagesDb = await trx
            .update(schema.messages)
            .set({ replyTo: null })
            .where(
              and(
                eq(schema.messages.contactUserId, message.contactUserId),
                sql`json_extract(${schema.messages.replyTo}, '$.originalMsgId') = ${encodeToBase64(message.messageId!)}`
              )
            )
            .returning();
          updatedMessages = updatedMessagesDb.map(row =>
            rowToMessage(row as MessageRow)
          );
        }
      }
    );

    // function to be called after the db transaction is committed.
    // Send events only when we are sure corresponding operation are saved in db
    const postDbCommit = () => {
      this.eventEmitter.emit(SdkEventType.MESSAGE_DELETED, {
        messages: [message, ...deletedMessages],
      });
      if (updatedMessages.length > 0) {
        this.eventEmitter.emit(SdkEventType.MESSAGE_UPDATED, {
          messages: updatedMessages,
        });
      }
      if (discussionUpdated) {
        this.eventEmitter.emit(SdkEventType.DISCUSSION_UPDATED, discussion.id);
      }
    };

    if (!parentTx) {
      // if we are not in a db transaction, we can just emit the event and return
      postDbCommit();
      return { success: true, data: null };
    } else {
      // if we are in a db transaction, we need to return a function that will be called after the transaction is committed
      return { success: true, data: postDbCommit };
    }
  }

  /**
   * Delete a message by its database ID (outgoing or incoming in 1-to-1).
   * Marks the local message as deleted and enqueues a delete control message
   * so the peer can mark their copy as deleted as well.
   *
   * Both sides can delete any message for plausible deniability.
   */
  async deleteMessage(id: number): Promise<boolean> {
    const row = await this.queries.messages.getById(id);
    if (!row) return false;
    if (!row.messageId)
      throw new Error('Cannot delete a message that has no messageId');

    const ownerUserId = this.session.userIdEncoded;

    const callbackAfterDbCommit: (() => void) | null =
      await this.queries.conn.withTransaction(async tx => {
        const res = await this.PerformDeleteMessage(rowToMessage(row), tx);
        if (!res.success) {
          tx.rollback(); // if deleting the message from the db fails, rollback the transaction
          throw new Error(
            res.error?.message ?? 'Failed to delete message from db'
          );
        }

        // Send the delete control message to the peer
        const controlMessage: Omit<Message, 'id'> = {
          ownerUserId,
          contactUserId: row.contactUserId,
          content: '',
          type: MessageType.DELETED,
          direction: MessageDirection.OUTGOING,
          status: MessageStatus.WAITING_SESSION,
          timestamp: new Date(),
          deleteOf: { originalMsgId: row.messageId! }, // row.messageId was previously verified to be not null
        };

        const result = await this.sendMessage(controlMessage, tx);
        if (!result.success) {
          tx.rollback(); // if sending the delete control message fails, rollback the transaction
          throw new Error(result.error ?? 'Failed to enqueue delete message');
        }
        return res.data;
      }, 'immediate');

    if (callbackAfterDbCommit) {
      callbackAfterDbCommit();
    }
    await this.processSendQueueForContact(row.contactUserId);

    return true;
  }

  async sendReaction(
    contactUserId: string,
    emoji: string,
    originalMsgId: Uint8Array
  ): Promise<SendMessageResult> {
    const message: Omit<Message, 'id'> = {
      ownerUserId: this.session.userIdEncoded,
      contactUserId,
      content: emoji,
      type: MessageType.REACTION,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.WAITING_SESSION,
      timestamp: new Date(),
      reactionOf: { originalMsgId },
    };
    const result = await this.send(message);
    return result;
  }

  private async performEditMessage(
    newContent: string,
    originalMsg: Message,
    metadata: Record<string, unknown>,
    tx?: GossipSqliteTx
  ): Promise<Result<(() => void) | null, Error>> {
    if (!originalMsg.id) {
      return { success: false, error: new Error('Message ID is required') };
    }
    const db = tx ?? this.queries.conn.db;
    let discussionUpdatedId: number | undefined;
    try {
      await db
        .update(schema.messages)
        .set({ content: newContent, metadata: serializeMetadata(metadata) })
        .where(eq(schema.messages.id, originalMsg.id))
        .returning();

      const discussion = await this.queries.discussions.getByOwnerAndContact(
        originalMsg.ownerUserId,
        originalMsg.contactUserId,
        tx
      );
      if (!discussion) {
        return { success: false, error: new Error('Discussion not found') };
      }
      if (discussion.lastMessageId === originalMsg.id) {
        await this.queries.discussions.updateById(
          discussion.id,
          {
            lastMessageContent: newContent,
            updatedAt: new Date(),
          },
          tx
        );
        discussionUpdatedId = discussion.id;
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }

    const postDbCommit = () => {
      if (discussionUpdatedId) {
        this.eventEmitter.emit(
          SdkEventType.DISCUSSION_UPDATED,
          discussionUpdatedId
        );
      }
    };

    if (!tx) {
      // if we are not in a db transaction, we can just emit the event and return
      postDbCommit();
      return { success: true, data: null };
    } else {
      // if we are in a db transaction, we need to return a function that will be called after the transaction is committed
      return { success: true, data: postDbCommit };
    }
  }

  /**
   * Edit an outgoing message by its database ID.
   * Updates the local content (preserving timestamp) and enqueues an edit
   * control message so the peer can update their copy as well.
   */
  async editMessage(id: number, newContent: string): Promise<boolean> {
    const row = await this.queries.messages.getById(id);
    if (!row) return false;
    if (row.direction !== MessageDirection.OUTGOING) return false;
    if (!row.messageId || row.messageId.length !== MESSAGE_ID_SIZE)
      throw new Error('Cannot edit a message that has no valid messageId');

    const ownerUserId = this.session.userIdEncoded;

    const existingMetadata = deserializeMetadata(row.metadata) ?? {};
    const mergedMetadata = { ...existingMetadata, edited: true };

    const callbackAfterDbCommit: (() => void) | null =
      await this.queries.conn.withTransaction(async tx => {
        const res = await this.performEditMessage(
          newContent,
          rowToMessage(row),
          mergedMetadata,
          tx
        );
        if (!res.success) {
          tx.rollback();
          throw new Error(res.error?.message ?? 'Failed to edit message in db');
        }

        const controlMessage: Omit<Message, 'id'> = {
          ownerUserId,
          contactUserId: row.contactUserId,
          content: newContent,
          type: MessageType.TEXT,
          direction: MessageDirection.OUTGOING,
          status: MessageStatus.WAITING_SESSION,
          timestamp: new Date(),
          editOf: { originalMsgId: row.messageId! }, // row.messageId was previously verified to be not null
          metadata: { control: 'edit' },
        };

        const result = await this.sendMessage(controlMessage, tx);
        if (!result.success) {
          tx.rollback();
          throw new Error(result.error ?? 'Failed to enqueue edit message');
        }
        return res.data;
      }, 'immediate');

    if (callbackAfterDbCommit) {
      callbackAfterDbCommit();
    }
    await this.processSendQueueForContact(row.contactUserId);
    return true;
  }

  /**
   * Hard-delete messages that have exceeded their discussion retention duration.
   * Called periodically from the background refresh cycle.
   * Emits MESSAGE_RECEIVED if any messages were deleted to trigger UI refresh.
   */
  async deleteExpiredMessages(ownerUserId: string): Promise<void> {
    const allRows = await this.queries.discussions.getByOwner(ownerUserId);
    const withRetention = allRows.filter(
      d => d.messageRetentionDuration != null && d.messageRetentionDuration > 0
    );
    if (withRetention.length === 0) return;

    const expiredRows = await this.queries.messages.getExpiredByOwner(
      ownerUserId,
      withRetention
    );
    if (expiredRows.length === 0) return;

    await Promise.all(
      expiredRows.map(async row => {
        const result = await this.PerformDeleteMessage(rowToMessage(row));
        if (!result.success) {
          throw result.error ?? new Error('Failed to delete expired message');
        }
      })
    );
  }

  // Mark a message as read. Returns true if the message has been marked as read, false if it was already marked as read or doesn't exist.
  async markAsRead(id: number): Promise<boolean> {
    // Check current message status from DB to avoid race conditions
    const row = await this.queries.messages.getById(id);

    if (!row || row.status !== MessageStatus.DELIVERED) {
      // Message was already marked as read or doesn't exist
      return false;
    }

    const message = rowToMessage(row);

    // Perform message status update and unread count decrement atomically in a transaction
    const discussionId = await this.queries.conn.withTransaction(async tx => {
      // Update message status
      await this.queries.messages.updateById(
        id,
        { status: MessageStatus.READ },
        tx
      );

      // Atomically decrement discussion unread count
      const discussion = await this.queries.discussions.getByOwnerAndContact(
        message.ownerUserId,
        message.contactUserId,
        tx
      );
      if (!discussion || !discussion.id) {
        throw new Error('Discussion not found');
      }

      if (discussion) {
        await this.queries.discussions.decrementUnreadCount(discussion.id, tx);
      }
      return discussion.id;
    }, 'immediate');

    this.eventEmitter.emit(SdkEventType.MESSAGE_READ, id);
    this.eventEmitter.emit(SdkEventType.DISCUSSION_UPDATED, discussionId);

    return true;
  }
}
