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
import { encodeToBase64, decodeFromBase64 } from '../utils/base64.js';
import { Result } from '../utils/type.js';
import { sessionStatusToString } from '../wasm/session.js';
import { Logger } from '../utils/logs.js';
import { SdkConfig, defaultSdkConfig } from '../config/sdk.js';
import { SdkEventEmitter, SdkEventType } from '../core/SdkEventEmitter.js';
import type { RefreshService } from './refresh.js';
import { Queries } from '../db/queries/index.js';
import { QueueManager } from '../utils/queue.js';

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
  private refreshService?: RefreshService;
  private queueManager?: QueueManager;
  private processingContacts = new Set<string>();
  private isFetchingMessages = false;
  private queries: Queries;

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

  setRefreshService(refreshService: RefreshService): void {
    this.refreshService = refreshService;
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
        await this.queries.activeSeekers.replaceAll(seekers);
        this.eventEmitter.emit(SdkEventType.SEEKERS_UPDATED, seekers);
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
    message: Omit<Message, 'id'>
  ): Promise<number> {
    const messageId = await this.queries.messages.insert({
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
    });

    const discussion = await this.queries.discussions.getByOwnerAndContact(
      message.ownerUserId,
      message.contactUserId
    );

    if (
      discussion &&
      message.type !== MessageType.KEEP_ALIVE &&
      message.type !== MessageType.REACTION &&
      message.type !== MessageType.RETENTION_POLICY
    ) {
      await this.queries.discussions.updateById(discussion.id, {
        lastMessageId: messageId,
        lastMessageContent: message.content,
        lastMessageTimestamp: message.timestamp,
        updatedAt: new Date(),
      });

      if (message.direction === MessageDirection.INCOMING) {
        await this.queries.discussions.incrementUnreadCount(discussion.id);
      }
    }

    return messageId;
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

        if (target.type === MessageType.REACTION) {
          // Reaction delete: hard-delete the row, not "[Message deleted]"
          await this.queries.messages.deleteById(target.id);
          this.emitMessageReceived({
            ...target,
            type: MessageType.DELETED,
          });
        } else {
          // Regular message delete: mark as deleted
          this.emitMessageReceived({
            ...target,
            content: '[Message deleted]',
            type: MessageType.DELETED,
          });
          await this.queries.messages.updateById(target.id, {
            content: '[Message deleted]',
            type: MessageType.DELETED,
          });
        }

        continue;
      }

      // Handle edit control messages by updating the referenced message in-place
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

        await this.queries.messages.updateById(target.id, {
          content: message.content,
          metadata: serializeMetadata(mergedMetadata),
        });

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
        this.eventEmitter.emit(
          SdkEventType.DISCUSSION_UPDATED,
          message.senderId
        );
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

        // Emit before DB write so UI updates instantly
        this.emitMessageReceived({
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
        log.info('Duplicate message received, skipping', {
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

      // Emit before DB write — UI shows message instantly
      this.emitMessageReceived(incomingMsg);

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

  async findMessageBySeeker(
    seeker: Uint8Array,
    ownerUserId: string
  ): Promise<Message | undefined> {
    const row = await this.queries.messages.getByOwnerAndSeeker(
      ownerUserId,
      seeker
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
    }

    // After marking as DELIVERED, clean up DELIVERED keep-alive messages
    await this.queries.messages.deleteDeliveredKeepAlive(userId);

    if (toUpdate.length > 0) {
      logger
        .forMethod('acknowledgeMessages')
        .info(`acknowledged ${toUpdate.length} messages`);
    }
  }

  async sendMessage(message: Message): Promise<SendMessageResult> {
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
      message.contactUserId
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

    // Add message as WAITING_SESSION
    let messageId: number;
    try {
      messageId = await this.addMessageAndUpdateDiscussion({
        ...message,
        status: MessageStatus.WAITING_SESSION,
      });
    } catch (error) {
      return {
        success: false,
        error: 'Failed to add message to database, got error: ' + error,
      };
    }

    const queuedMessage = {
      ...message,
      id: messageId,
      status: MessageStatus.WAITING_SESSION,
    };

    /*
    Trigger a state update to send the new message.
    If the stateUpdate function is already running, it will be skipped.
    */
    await this.refreshService?.stateUpdate();

    return {
      success: true,
      message: queuedMessage,
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

  async resendMessages(messages: Map<string, Message[]>) {
    const log = logger.forMethod('resendMessages');

    let totalProcessed = 0;

    for (const [contactId, retryMessages] of messages.entries()) {
      totalProcessed += retryMessages.length;

      for (const msg of retryMessages) {
        if (!msg.id) continue;
        await this.queries.messages.updateById(msg.id, {
          status: MessageStatus.WAITING_SESSION,
          encryptedMessage: null,
          seeker: null,
          whenToSend: null,
        });
      }

      await this.processSendQueueForContact(contactId);
    }

    log.info('resend completed', {
      contacts: messages.size,
      messagesProcessed: totalProcessed,
    });
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

        let currentStatus = msg.status;
        let encryptedMessage = msg.encryptedMessage;
        let seeker = msg.seeker;
        let whenToSend = msg.whenToSend;

        // If the sessions is saturated it can't send messages on session manager
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
          whenToSend = new Date();

          await this.queries.messages.updateById(msg.id, {
            status: MessageStatus.READY,
            encryptedMessage,
            seeker,
            whenToSend,
            serializedContent,
          });
          currentStatus = MessageStatus.READY;
          log.debug('message updated to READY', {
            messageId: msg.id,
            status: currentStatus,
            content: msg.content,
            type: msg.type,
            direction: msg.direction,
          });
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

  /**
   * Get count of messages waiting for session with a specific contact.
   */
  async getWaitingMessageCount(contactUserId: string): Promise<number> {
    const ownerUserId = this.session.userIdEncoded;
    return this.queries.messages.getWaitingCount(ownerUserId, contactUserId);
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
  send(message: Omit<Message, 'id'>): Promise<SendMessageResult>;
  /**
   * Optimistic send: generates messageId, emits MESSAGE_OPTIMISTIC immediately,
   * and persists in the background. Returns synchronously.
   */
  send(
    message: Omit<Message, 'id'>,
    options: { optimistic: true }
  ): SendMessageResult;
  send(
    message: Omit<Message, 'id'>,
    options?: { optimistic?: boolean }
  ): SendMessageResult | Promise<SendMessageResult> {
    if (!options?.optimistic) {
      if (this.queueManager) {
        return this.queueManager.enqueue(message.contactUserId, () =>
          this.sendMessage(message)
        );
      }
      return this.sendMessage(message);
    }

    const log = logger.forMethod('send:optimistic');
    const peerId = decodeUserId(message.contactUserId);
    if (peerId.length !== 32) {
      return {
        success: false,
        error: 'Invalid contact userId (must be 32 bytes)',
      };
    }

    const messageId =
      message.type !== MessageType.KEEP_ALIVE &&
      message.type !== MessageType.RETENTION_POLICY
        ? crypto.getRandomValues(new Uint8Array(MESSAGE_ID_SIZE))
        : undefined;

    const optimisticMessage: Message = {
      ...message,
      messageId,
      status: MessageStatus.WAITING_SESSION,
    };

    this.eventEmitter.emit(SdkEventType.MESSAGE_OPTIMISTIC, optimisticMessage);
    log.info('optimistic send', { messageType: message.type });

    // Persist in background (non-optimistic path)
    this.send({ ...message, messageId }).then(
      result => {
        if (!result.success) {
          this.eventEmitter.emit(SdkEventType.WRITE_FAILED, {
            messageId,
            entityType: 'message',
            error: new Error(result.error ?? 'Unknown error'),
          });
        }
      },
      error => {
        log.error('optimistic send failed', { error });
        this.eventEmitter.emit(SdkEventType.WRITE_FAILED, {
          messageId,
          entityType: 'message',
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    );

    return { success: true, message: optimisticMessage };
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
    await this.refreshService?.stateUpdate();
    return result;
  }

  /** Fetch and decrypt messages from the protocol (alias) */
  async fetch(): Promise<MessageResult> {
    return this.fetchMessages();
  }

  /**
   * Delete an outgoing message by its database ID.
   * Marks the local message as deleted and enqueues a delete control message
   * so the peer can mark their copy as deleted as well.
   */
  async deleteMessage(id: number): Promise<boolean> {
    const row = await this.queries.messages.getById(id);
    if (!row) return false;
    if (row.direction !== MessageDirection.OUTGOING) return false;
    if (!row.messageId)
      throw new Error('Cannot delete a message that has no messageId');

    const original = rowToMessage(row);
    const ownerUserId = this.session.userIdEncoded;

    // Emit optimistic event so UI updates immediately (skip for reactions —
    // the store handles reaction removal separately).
    if (row.type !== MessageType.REACTION) {
      this.eventEmitter.emit(SdkEventType.MESSAGE_DELETED_OPTIMISTIC, {
        contactUserId: row.contactUserId,
        messageDbId: id,
        originalMsgId: row.messageId,
      });
    }

    try {
      await this.queries.messages.updateById(id, {
        content: '[Message deleted]',
        type: MessageType.DELETED,
      });

      const controlMessage: Omit<Message, 'id'> = {
        ownerUserId,
        contactUserId: row.contactUserId,
        content: '',
        type: MessageType.DELETED,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.WAITING_SESSION,
        timestamp: new Date(),
        deleteOf: { originalMsgId: row.messageId },
      };

      const result = await this.send(controlMessage);
      if (!result.success)
        throw new Error(result.error ?? 'Failed to enqueue delete message');

      await this.refreshService?.stateUpdate();
      return true;
    } catch (error) {
      // Rollback: emit failure so store can restore original
      if (row.type !== MessageType.REACTION) {
        this.eventEmitter.emit(SdkEventType.MESSAGE_DELETE_FAILED, {
          contactUserId: row.contactUserId,
          messageDbId: id,
          original,
        });
      }
      // Best-effort DB rollback
      await this.queries.messages
        .updateById(id, { content: original.content, type: original.type })
        .catch(() => {});
      throw error;
    }
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
    await this.refreshService?.stateUpdate();
    return result;
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

    const original = rowToMessage(row);
    const ownerUserId = this.session.userIdEncoded;

    const existingMetadata = deserializeMetadata(row.metadata) ?? {};
    const mergedMetadata = { ...existingMetadata, edited: true };

    // Emit optimistic event so UI updates immediately
    this.eventEmitter.emit(SdkEventType.MESSAGE_EDITED_OPTIMISTIC, {
      contactUserId: row.contactUserId,
      messageDbId: id,
      newContent,
      metadata: mergedMetadata,
    });

    try {
      await this.queries.messages.updateById(id, {
        content: newContent,
        metadata: serializeMetadata(mergedMetadata),
      });

      const controlMessage: Omit<Message, 'id'> = {
        ownerUserId,
        contactUserId: row.contactUserId,
        content: newContent,
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.WAITING_SESSION,
        timestamp: new Date(),
        editOf: { originalMsgId: row.messageId },
        metadata: { control: 'edit' },
      };

      const result = await this.send(controlMessage);
      if (!result.success)
        throw new Error(result.error ?? 'Failed to enqueue edit message');

      await this.refreshService?.stateUpdate();
      return true;
    } catch (error) {
      this.eventEmitter.emit(SdkEventType.MESSAGE_EDIT_FAILED, {
        contactUserId: row.contactUserId,
        messageDbId: id,
        original,
      });
      await this.queries.messages
        .updateById(id, {
          content: original.content,
          metadata: row.metadata ?? undefined,
        })
        .catch(() => {});
      throw error;
    }
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

    await this.queries.messages.deleteExpiredByOwner(
      ownerUserId,
      withRetention
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

    // Update message status
    await this.queries.messages.updateById(id, { status: MessageStatus.READ });

    // Atomically decrement discussion unread count
    const discussion = await this.queries.discussions.getByOwnerAndContact(
      message.ownerUserId,
      message.contactUserId
    );

    if (discussion) {
      await this.queries.discussions.decrementUnreadCount(discussion.id);
    }

    this.eventEmitter.emit(SdkEventType.MESSAGE_READ, id);

    return true;
  }
}
