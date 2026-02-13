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
} from '../db';
import {
  type MessageRow,
  getMessageById,
  getMessageByOwnerAndSeeker,
  insertMessage,
  updateMessageById,
  deleteDeliveredKeepAliveMessages,
  getOutgoingSentMessagesByOwner,
  getWaitingMessageCount as getWaitingCount,
  getSendQueueMessages,
  findDuplicateIncomingMessage,
} from '../queries';
import {
  getDiscussionByOwnerAndContact,
  updateDiscussionById,
} from '../queries';
import { replaceActiveSeekers } from '../queries';
import { decodeUserId, encodeUserId } from '../utils/userId';
import { IMessageProtocol, EncryptedMessage } from '../api/messageProtocol';
import { SessionStatus } from '../wasm/bindings';
import { SessionModule } from '../wasm';
import {
  serializeRegularMessage,
  serializeReplyMessage,
  serializeForwardMessage,
  serializeKeepAliveMessage,
  deserializeMessage,
} from '../utils/messageSerialization';
import { encodeToBase64, decodeFromBase64 } from '../utils/base64';
import { Result } from '../utils/type';
import { sessionStatusToString } from '../wasm/session';
import { Logger } from '../utils/logs';
import { SdkConfig, defaultSdkConfig } from '../config/sdk';
import { DiscussionService } from './discussion';
import { SdkEventEmitter, SdkEventType } from '../core/SdkEventEmitter';
import type { RefreshService } from './refresh';

// ---------------------------------------------------------------------------
// JSON serialization helpers for message fields stored as text in SQLite
// ---------------------------------------------------------------------------

/** Serialize replyTo/forwardOf to JSON string for SQLite storage.
 *  Uint8Array fields are base64-encoded. */
function serializeLinkedMessage(
  linked: { originalContent?: string; originalSeeker: Uint8Array } | undefined
): string | null {
  if (!linked) return null;
  return JSON.stringify({
    originalContent: linked.originalContent,
    originalSeeker: encodeToBase64(linked.originalSeeker),
  });
}

/** Deserialize replyTo/forwardOf from JSON string back to the Message interface shape. */
function deserializeLinkedMessage(
  json: string | null
): { originalContent?: string; originalSeeker: Uint8Array } | undefined {
  if (!json) return undefined;
  const parsed = JSON.parse(json);
  return {
    originalContent: parsed.originalContent ?? undefined,
    originalSeeker: decodeFromBase64(parsed.originalSeeker),
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
    replyTo: deserializeLinkedMessage(row.replyTo),
    forwardOf: deserializeLinkedMessage(row.forwardOf),
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
  replyTo?: {
    originalContent: string;
    originalSeeker: Uint8Array;
  };
  forwardOf?: {
    originalContent: string;
    originalSeeker: Uint8Array;
  };
  encryptedMessage: Uint8Array;
  type: MessageType;
}

const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

const logger = new Logger('MessageService');
export class MessageService {
  private messageProtocol: IMessageProtocol;
  private session: SessionModule;
  private discussionService: DiscussionService;
  private eventEmitter: SdkEventEmitter;
  private config: SdkConfig;
  private refreshService?: RefreshService;
  private processingContacts = new Set<string>();
  private isFetchingMessages = false;

  constructor(
    messageProtocol: IMessageProtocol,
    session: SessionModule,
    discussionService: DiscussionService,
    eventEmitter: SdkEventEmitter,
    config: SdkConfig = defaultSdkConfig
  ) {
    this.messageProtocol = messageProtocol;
    this.session = session;
    this.discussionService = discussionService;
    this.eventEmitter = eventEmitter;
    this.config = config;
    void this.discussionService;
  }

  setRefreshService(refreshService: RefreshService): void {
    this.refreshService = refreshService;
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
        await replaceActiveSeekers(seekers);
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
    const messageId = await insertMessage({
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
      replyTo: serializeLinkedMessage(message.replyTo),
      forwardOf: serializeLinkedMessage(message.forwardOf),
      encryptedMessage: message.encryptedMessage,
      whenToSend: message.whenToSend,
    });

    const discussion = await getDiscussionByOwnerAndContact(
      message.ownerUserId,
      message.contactUserId
    );

    if (discussion) {
      await updateDiscussionById(discussion.id, {
        lastMessageId: messageId,
        lastMessageContent: message.content,
        lastMessageTimestamp: message.timestamp,
        unreadCount:
          message.direction === MessageDirection.INCOMING
            ? discussion.unreadCount + 1
            : discussion.unreadCount,
        updatedAt: new Date(),
      });
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

          decrypted.push({
            content: deserialized.content,
            sentAt: new Date(Number(out.timestamp)),
            senderId: encodeUserId(out.user_id),
            seeker: msg.seeker,
            encryptedMessage: msg.ciphertext,
            type: deserialized.type,
            replyTo: deserialized.replyTo
              ? {
                  originalContent: deserialized.replyTo.originalContent,
                  originalSeeker: deserialized.replyTo.originalSeeker,
                }
              : undefined,
            forwardOf: deserialized.forwardOf
              ? {
                  originalContent: deserialized.forwardOf.originalContent,
                  originalSeeker: deserialized.forwardOf.originalSeeker,
                }
              : undefined,
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
      const discussion = await getDiscussionByOwnerAndContact(
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

      // Check for duplicate message (same content + similar timestamp from same sender)
      // This handles edge case: app crashes after network send but before DB update,
      // message gets re-sent on restart, peer receives duplicate
      const isDuplicate = await this.isDuplicateMessage(
        ownerUserId,
        message.senderId,
        message.content,
        message.sentAt
      );

      if (isDuplicate) {
        log.info('skipping duplicate message', {
          senderId: message.senderId,
          preview: message.content.slice(0, 30),
          timestamp: message.sentAt.toISOString(),
        });
        continue;
      }

      let replyToMessageId: number | undefined;
      if (message.replyTo?.originalSeeker) {
        const original = await this.findMessageBySeeker(
          message.replyTo.originalSeeker,
          ownerUserId
        );
        if (!original) {
          log.warn('reply target not found', {
            originalSeeker: encodeToBase64(message.replyTo.originalSeeker),
          });
        }
        replyToMessageId = original?.id;
      }

      const replyToField = message.replyTo
        ? {
            // Store the original content as a fallback only if we couldn't find
            // the original message in the database (replyToMessageId is undefined).
            // If the original message exists, we don't need to store the content
            // since we can fetch it using the originalSeeker.
            originalContent: replyToMessageId
              ? undefined
              : message.replyTo.originalContent,
            // Store the seeker (used to find the original message)
            originalSeeker: message.replyTo.originalSeeker,
          }
        : undefined;
      const forwardOfField = message.forwardOf
        ? {
            originalContent: message.forwardOf.originalContent,
            originalSeeker: message.forwardOf.originalSeeker,
          }
        : undefined;

      const id = await insertMessage({
        ownerUserId,
        contactUserId: discussion.contactUserId,
        content: message.content,
        type: message.type,
        direction: MessageDirection.INCOMING,
        status: MessageStatus.DELIVERED,
        timestamp: message.sentAt,
        metadata: serializeMetadata({}),
        seeker: message.seeker,
        replyTo: serializeLinkedMessage(replyToField),
        forwardOf: serializeLinkedMessage(forwardOfField),
      });

      // Update discussion in SQLite
      const now = new Date();
      await updateDiscussionById(discussion.id, {
        lastMessageId: id,
        lastMessageContent: message.content,
        lastMessageTimestamp: message.sentAt,
        updatedAt: now,
        lastSyncTimestamp: now,
        unreadCount: discussion.unreadCount + 1,
      });

      storedIds.push(id);

      // Emit event for new message
      const row = await getMessageById(id);
      if (row) {
        this.eventEmitter.emit(
          SdkEventType.MESSAGE_RECEIVED,
          rowToMessage(row)
        );
      }
    }

    return storedIds;
  }

  /**
   * Check if a message is a duplicate based on content and timestamp.
   *
   * A message is considered duplicate if:
   * - Same sender (contactUserId)
   * - Same content
   * - Incoming direction
   * - Timestamp within deduplication window (default 30 seconds)
   *
   * This handles the edge case where:
   * 1. Sender sends message successfully to network
   * 2. Sender app crashes before updating DB status to SENT
   * 3. On restart, message is reset to WAITING_SESSION and re-sent
   * 4. Receiver gets the same message twice with different seekers
   *
   * @param ownerUserId - The owner's user ID
   * @param contactUserId - The sender's user ID
   * @param content - The message content
   * @param timestamp - The message timestamp
   * @returns true if a duplicate exists
   */
  private async isDuplicateMessage(
    ownerUserId: string,
    contactUserId: string,
    content: string,
    timestamp: Date
  ): Promise<boolean> {
    const windowMs = this.config.messages.deduplicationWindowMs;
    const windowStart = new Date(timestamp.getTime() - windowMs);
    const windowEnd = new Date(timestamp.getTime() + windowMs);

    const existing = await findDuplicateIncomingMessage(
      ownerUserId,
      contactUserId,
      content,
      windowStart,
      windowEnd
    );

    return existing !== undefined;
  }

  async findMessageBySeeker(
    seeker: Uint8Array,
    ownerUserId: string
  ): Promise<Message | undefined> {
    const row = await getMessageByOwnerAndSeeker(ownerUserId, seeker);
    return row ? rowToMessage(row) : undefined;
  }

  private async acknowledgeMessages(
    seekers: Set<string>,
    userId: string
  ): Promise<void> {
    if (seekers.size === 0) return;

    // Find SENT outgoing messages, then filter by seeker match
    const candidates = await getOutgoingSentMessagesByOwner(userId);

    const toUpdate = candidates.filter(
      m => m.seeker != null && seekers.has(encodeToBase64(m.seeker))
    );

    // Mark matching OUTGOING SENT messages as DELIVERED and clear encrypted data
    for (const m of toUpdate) {
      await updateMessageById(m.id, {
        status: MessageStatus.DELIVERED,
        encryptedMessage: null,
        whenToSend: null,
      });
    }

    // After marking as DELIVERED, clean up DELIVERED keep-alive messages
    await deleteDeliveredKeepAliveMessages(userId);

    if (toUpdate.length > 0) {
      logger
        .forMethod('acknowledgeMessages')
        .info(`acknowledged ${toUpdate.length} messages`);
    }
  }

  async sendMessage(message: Message): Promise<SendMessageResult> {
    const log = logger.forMethod('sendMessage');
    log.info('queueing message', {
      messageContent: message.content,
      messageType: message.type,
      messageReplyTo: message.replyTo,
      messageForwardOf: message.forwardOf,
    });

    const peerId = decodeUserId(message.contactUserId);
    if (peerId.length !== 32) {
      return {
        success: false,
        error: 'Invalid contact userId (must be 32 bytes)',
      };
    }

    // Look up discussion
    const discussion = await getDiscussionByOwnerAndContact(
      message.ownerUserId,
      message.contactUserId
    );
    if (!discussion) {
      return { success: false, error: 'Discussion not found' };
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
    if (message.replyTo?.originalSeeker) {
      const originalMessage = await this.findMessageBySeeker(
        message.replyTo.originalSeeker,
        message.ownerUserId
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
          originalMessage.content,
          message.replyTo.originalSeeker
        ),
      };
    } else if (message.type === MessageType.KEEP_ALIVE) {
      return {
        success: true,
        data: serializeKeepAliveMessage(),
      };
    } else if (
      message.forwardOf?.originalContent &&
      message.forwardOf.originalSeeker
    ) {
      try {
        return {
          success: true,
          data: serializeForwardMessage(
            message.forwardOf.originalContent,
            message.content,
            message.forwardOf.originalSeeker
          ),
        };
      } catch (error) {
        log.error('failed to serialize forward message', error);
        return {
          success: false,
          error: 'Failed to serialize forward message',
        };
      }
    } else {
      // Regular message with type tag
      return {
        success: true,
        data: serializeRegularMessage(message.content),
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
        await updateMessageById(msg.id, {
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
      const discussion = await getDiscussionByOwnerAndContact(
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
        ![SessionStatus.Active, SessionStatus.SelfRequested].includes(
          sessionStatus
        )
      ) {
        log.info('session not active or self requested, skipping send queue', {
          contactUserId,
          sessionStatus: sessionStatusToString(sessionStatus),
        });
        return {
          success: false,
          error: new Error('Session not active or self requested'),
        };
      }

      // retrieve all messages in send queue that need to be updated for this contact
      const pendingMessages = (
        await getSendQueueMessages(ownerUserId, contactUserId)
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

        if (currentStatus === MessageStatus.WAITING_SESSION) {
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
            log.warn('session manager returned null for queued message', {
              messageId: msg.id,
            });
            return {
              success: false,
              error: new Error(
                'Session manager returned null for queued message'
              ),
            };
          }

          encryptedMessage = sendOutput.data;
          seeker = sendOutput.seeker;
          whenToSend = new Date();

          await updateMessageById(msg.id, {
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
            await updateMessageById(msg.id, {
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
            const latestRow = await getMessageById(msg.id);

            let sent = false;
            if (
              latestRow && // ensure the discussion has not been deleted
              latestRow.status === MessageStatus.READY // ensure the discussion has not been reset with all pending messages reset to WAITING_SESSION
            ) {
              await updateMessageById(msg.id, {
                status: MessageStatus.SENT,
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
          } catch (error) {
            log.error('network send failed for queued message', {
              messageId: msg.id,
              error,
            });
            const latestRow = await getMessageById(msg.id);
            if (
              latestRow && // ensure the discussion has not been deleted
              latestRow.status === MessageStatus.READY // ensure the discussion has not been reset with all pending messages reset to WAITING_SESSION
            ) {
              await updateMessageById(msg.id, {
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
    const rows = await getSendQueueMessages(ownerUserId, contactUserId);
    return rows.length;
  }

  /**
   * Send a keep-alive message without adding it to the message history.
   */
  async sendKeepAlive(contactUserId: string): Promise<void> {
    const log = logger.forMethod('sendKeepAlive');
    const peerId = decodeUserId(contactUserId);
    const sessionStatus = this.session.peerSessionStatus(peerId);
    if (sessionStatus !== SessionStatus.Active) {
      return;
    }

    const serialized = serializeKeepAliveMessage();
    const sendOutput = await this.session.sendMessage(peerId, serialized);
    if (!sendOutput) {
      log.warn('session manager failed to encrypt keep-alive', {
        contactUserId,
      });
      return;
    }

    try {
      await this.messageProtocol.sendMessage({
        seeker: sendOutput.seeker,
        ciphertext: sendOutput.data,
      });
    } catch (error) {
      log.error('keep-alive send failed', {
        contactUserId,
        error,
      });
    }
  }

  /**
   * Get count of messages waiting for session with a specific contact.
   */
  async getWaitingMessageCount(contactUserId: string): Promise<number> {
    const ownerUserId = this.session.userIdEncoded;
    return getWaitingCount(ownerUserId, contactUserId);
  }

  // Mark a message as read. Returns true if the message has been marked as read, false if it was already marked as read or doesn't exist.
  async markAsRead(id: number): Promise<boolean> {
    // Check current message status from DB to avoid race conditions
    const row = await getMessageById(id);

    if (!row || row.status !== MessageStatus.DELIVERED) {
      // Message was already marked as read or doesn't exist
      return false;
    }

    const message = rowToMessage(row);

    // Update message status
    await updateMessageById(id, { status: MessageStatus.READ });

    // Decrement discussion unread count
    const discussion = await getDiscussionByOwnerAndContact(
      message.ownerUserId,
      message.contactUserId
    );

    if (discussion && discussion.unreadCount > 0) {
      await updateDiscussionById(discussion.id, {
        unreadCount: discussion.unreadCount - 1,
      });
    }

    return true;
  }
}
