/**
 * Message Reception Service
 *
 * Handles fetching encrypted messages from the protocol and decrypting them.
 * This service works both in host app contexts and SDK/automation context.
 */

import {
  type Message,
  type GossipDatabase,
  MessageDirection,
  MessageStatus,
  MessageType,
  MESSAGE_ID_SIZE,
} from '../db';
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
import { encodeToBase64 } from '../utils/base64';
import { Result } from '../utils/type';
import { sessionStatusToString } from '../wasm/session';
import { Logger } from '../utils/logs';
import { SdkConfig, defaultSdkConfig } from '../config/sdk';
import { DiscussionService } from './discussion';
import { SdkEventEmitter, SdkEventType } from '../core/SdkEventEmitter';

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
  encryptedMessage: Uint8Array;
  type: MessageType;
}

const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

const logger = new Logger('MessageService');
export class MessageService {
  private db: GossipDatabase;
  private messageProtocol: IMessageProtocol;
  private session: SessionModule;
  private discussionService: DiscussionService;
  private eventEmitter: SdkEventEmitter;
  private config: SdkConfig;
  private processingContacts = new Set<string>();
  private isFetchingMessages = false;

  constructor(
    db: GossipDatabase,
    messageProtocol: IMessageProtocol,
    session: SessionModule,
    discussionService: DiscussionService,
    eventEmitter: SdkEventEmitter,
    config: SdkConfig = defaultSdkConfig
  ) {
    this.db = db;
    this.messageProtocol = messageProtocol;
    this.session = session;
    this.discussionService = discussionService;
    this.eventEmitter = eventEmitter;
    this.config = config;
    void this.discussionService;
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
        await this.db.setActiveSeekers(seekers);
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
      const result = await this.db.transaction(
        'rw',
        this.db.messages,
        this.db.discussions,
        async () => {
          const discussion = await this.db.getDiscussionByOwnerAndContact(
            ownerUserId,
            message.senderId
          );

          if (!discussion) {
            log.error('no discussion for incoming message', {
              senderId: message.senderId,
              preview: message.content.slice(0, 50),
            });
            return null;
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
            return null;
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

          const id = await this.db.messages.add({
            ownerUserId,
            contactUserId: discussion.contactUserId,
            content: message.content,
            type: message.type,
            direction: MessageDirection.INCOMING,
            status: MessageStatus.DELIVERED,
            timestamp: message.sentAt,
            metadata: {},
            messageId: message.messageId,
            replyTo: message.replyTo
              ? {
                  originalMsgId: message.replyTo.originalMsgId,
                }
              : undefined,

            forwardOf: message.forwardOf
              ? {
                  originalContent: message.forwardOf.originalContent,
                  originalContactId: message.forwardOf.originalContactId,
                }
              : undefined,
          });
          const now = new Date();
          await this.db.discussions.update(discussion.id, {
            lastMessageId: id,
            lastMessageContent: message.content,
            lastMessageTimestamp: message.sentAt,
            updatedAt: now,
            lastSyncTimestamp: now,
            unreadCount: discussion.unreadCount + 1,
          });
          return id;
        }
      );

      if (result === null) {
        continue;
      }

      const id = result;
      storedIds.push(id);

      // Emit event for new message
      const storedMessage = await this.db.messages.get(id);
      if (storedMessage) {
        this.eventEmitter.emit(SdkEventType.MESSAGE_RECEIVED, storedMessage);
      }
    }

    return storedIds;
  }

  /**
   * Checks for duplicate incoming messages in the message database based on messageId.
   *
   * A message is considered a duplicate if:
   * - It has the same messageId
   * - It is from the same sender (contactUserId)
   * - Belongs to the same conversation (ownerUserId)
   *
   * This protects against scenarios where:
   * 1. A sender successfully delivers a message to the network,
   * 2. Their app crashes or resets before marking the message as SENT in the local DB,
   * 3. On restart, the sender's app re-sends the message (possibly with a different seeker),
   * 4. The receiver gets the same message twice,
   * 5. Duplicates are prevented by matching messageId byte-for-byte.
   *
   * This method uses messageId (usually a 12-byte random value) for exact match detection.
   * If a duplicate is found, it updates certain fields (e.g., content, replyTo, forwardOf)
   * on the existing message and returns true.
   *
   * @param message - The incoming decrypted message object.
   * @param ownerUserId - The userId of the message database owner (the recipient).
   * @returns true if a duplicate message (by messageId) was found; otherwise false.
   */
  private async handleDuplicateMessageId(
    message: Decrypted,
    ownerUserId: string
  ): Promise<boolean> {
    // Check for duplicate message using messageId (12 bytes random)
    if (message.messageId) {
      const existingWithMessageId = await this.db.messages
        .where('[ownerUserId+contactUserId]')
        .equals([ownerUserId, message.senderId])
        .and(m => {
          if (!m.messageId || !message.messageId) return false;
          if (m.messageId.length !== message.messageId.length) return false;
          for (let i = 0; i < m.messageId.length; i++) {
            if (m.messageId[i] !== message.messageId[i]) return false;
          }
          return true;
        })
        .first();

      if (existingWithMessageId) {
        await this.db.messages.update(existingWithMessageId.id!, {
          content: message.content,
          replyTo: message.replyTo,
          forwardOf: message.forwardOf,
        });
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
    const baseQuery = contactUserId
      ? this.db.messages
          .where('[ownerUserId+contactUserId]')
          .equals([ownerUserId, contactUserId])
      : this.db.messages.where('ownerUserId').equals(ownerUserId);

    return await baseQuery
      .and(m => {
        if (!m.messageId || m.messageId.length !== messageId.length) {
          return false;
        }
        for (let i = 0; i < messageId.length; i++) {
          if (m.messageId[i] !== messageId[i]) return false;
        }
        return true;
      })
      .first();
  }

  private async acknowledgeMessages(
    seekers: Set<string>,
    userId: string
  ): Promise<void> {
    if (seekers.size === 0) return;

    const updatedCount = await this.db.transaction(
      'rw',
      this.db.messages,
      async () => {
        // Mark matching OUTGOING SENT messages as DELIVERED
        const count = await this.db.messages
          .where('[ownerUserId+direction+status]')
          .equals([userId, MessageDirection.OUTGOING, MessageStatus.SENT])
          .filter(
            message =>
              message.seeker !== undefined &&
              seekers.has(encodeToBase64(message.seeker))
          )
          .modify({
            status: MessageStatus.DELIVERED,
            serializedContent: undefined,
            seeker: undefined,
          });

        // After marking as DELIVERED, clean up DELIVERED keep-alive messages
        await this.db.messages
          .where({
            ownerUserId: userId,
            status: MessageStatus.DELIVERED,
            type: MessageType.KEEP_ALIVE,
          })
          .delete();

        return count;
      }
    );

    if (updatedCount > 0) {
      logger
        .forMethod('acknowledgeMessages')
        .info(`acknowledged ${updatedCount} messages`);
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

    // Run getDiscussionByOwnerAndContact and addMessage in a transaction
    let discussion;
    let messageId;

    const error = await this.db.transaction(
      'rw',
      this.db.discussions,
      this.db.messages,
      async () => {
        discussion = await this.db.getDiscussionByOwnerAndContact(
          message.ownerUserId,
          message.contactUserId
        );
        if (!discussion) {
          // If the discussion doesn't exist (it may have been deleted by the user), Dexie aborts the transaction.
          return new Error('Discussion not found');
        }

        try {
          const randomMessageId =
            message.type !== MessageType.KEEP_ALIVE
              ? crypto.getRandomValues(new Uint8Array(MESSAGE_ID_SIZE))
              : undefined;
          message.messageId = randomMessageId;
          messageId = await this.db.addMessage({
            ...message,
            status: MessageStatus.WAITING_SESSION,
          });
        } catch (error) {
          return new Error(
            'Failed to add message to database, got error: ' + error
          );
        }
      }
    );

    if (error) {
      return { success: false, error: error.message };
    }

    const queuedMessage = {
      ...message,
      id: messageId,
      status: MessageStatus.WAITING_SESSION,
    };

    return {
      success: true,
      message: queuedMessage,
    };
  }

  private async serializeMessage(
    message: Message
  ): Promise<Result<Uint8Array, string>> {
    const log = logger.forMethod('serializeMessage');

    if (!message.messageId && message.type !== MessageType.KEEP_ALIVE) {
      return {
        success: false,
        error: 'Message ID is required',
      };
    }

    if (message.replyTo) {
      const originalMessage = await this.findMessageByMsgId(
        message.replyTo.originalMsgId,
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
          message.replyTo.originalMsgId,
          message.messageId!
        ),
      };
    } else if (message.type === MessageType.KEEP_ALIVE) {
      return {
        success: true,
        data: serializeKeepAliveMessage(),
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
        await this.db.messages.update(msg.id, {
          status: MessageStatus.WAITING_SESSION,
          encryptedMessage: undefined,
          seeker: undefined,
          whenToSend: undefined,
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
      const discussion = await this.db.getDiscussionByOwnerAndContact(
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
          SessionStatus.SelfRequested,
          SessionStatus.Saturated,
        ].includes(sessionStatus)
      ) {
        log.info(
          'session not active, self requested or saturated, skipping send queue',
          {
            contactUserId,
            sessionStatus: sessionStatusToString(sessionStatus),
          }
        );
        return {
          success: false,
          error: new Error('Session not active, self requested or saturated'),
        };
      }

      // retrieve all message in send queue that need to be updated for this contact
      const pendingMessages = await this.db.messages
        .where('[ownerUserId+contactUserId]')
        .equals([ownerUserId, contactUserId])
        .and(
          msg =>
            msg.direction === MessageDirection.OUTGOING &&
            [MessageStatus.WAITING_SESSION, MessageStatus.READY].includes(
              msg.status
            )
        )
        .sortBy('timestamp');

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

          await this.db.messages.update(msg.id, {
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
            await this.db.messages.update(msg.id, {
              status: MessageStatus.WAITING_SESSION,
              encryptedMessage: undefined,
              seeker: undefined,
              whenToSend: undefined,
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

            // update the db
            const sent = await this.db.transaction(
              'rw',
              this.db.messages,
              async () => {
                try {
                  const latest = await this.db.messages.get(msg.id);
                  if (
                    latest && // ensure the discussion has not been deleted
                    latest.status === MessageStatus.READY // ensure the discussion has not been reset with all pending messages reset to WAITING_SESSION
                  ) {
                    await this.db.messages.update(msg.id, {
                      status: MessageStatus.SENT,
                      encryptedMessage: undefined,
                      whenToSend: undefined,
                    });
                    return true;
                  }
                } catch (error) {
                  log.error('failed to update message status to SENT', {
                    messageId: msg.id,
                    error,
                  });
                  return false;
                }
                return false;
              }
            );
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
            await this.db.transaction('rw', this.db.messages, async () => {
              const latest = await this.db.messages.get(msg.id);
              if (
                latest && // ensure the discussion has not been deleted
                latest.status === MessageStatus.READY // ensure the discussion has not been reset with all pending messages reset to WAITING_SESSION
              ) {
                await this.db.messages.update(msg.id, {
                  whenToSend: new Date(
                    Date.now() + this.config.messages.retryDelayMs
                  ),
                });
              }
            });
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
    return await this.db.messages
      .where('[ownerUserId+contactUserId]')
      .equals([ownerUserId, contactUserId])
      .and(
        msg =>
          msg.direction === MessageDirection.OUTGOING &&
          [MessageStatus.WAITING_SESSION, MessageStatus.READY].includes(
            msg.status
          )
      )
      .count();
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
    return await this.db.messages
      .where('[ownerUserId+contactUserId+status]')
      .equals([ownerUserId, contactUserId, MessageStatus.WAITING_SESSION])
      .count();
  }

  // Mark a message as read. Returns true if the message has been marked as read, false if it was already marked as read or doesn't exist.
  async markAsRead(id: number): Promise<boolean> {
    return await this.db.transaction(
      'rw',
      [this.db.messages, this.db.discussions],
      async () => {
        // Check current message status from DB to avoid race conditions
        const message = await this.db.messages.get(id);
        if (!message || message.status !== MessageStatus.DELIVERED) {
          // Message was already marked as read or doesn't exist
          return false;
        }

        // Update message status
        await this.db.messages.update(id, {
          status: MessageStatus.READ,
        });

        // Decrement discussion unread count
        await this.db.discussions
          .where('[ownerUserId+contactUserId]')
          .equals([message.ownerUserId, message.contactUserId])
          .modify(discussion => {
            if (discussion.unreadCount > 0) {
              discussion.unreadCount -= 1;
            }
          });
        return true;
      }
    );
  }
}
