/**
 * Message Reception Service
 *
 * Handles fetching encrypted messages from the protocol and decrypting them.
 * This service works both in host app contexts and SDK/automation context.
 */

import {
  DiscussionStatus,
  type Message,
  type GossipDatabase,
  MessageDirection,
  MessageStatus,
  MessageType,
} from '../db';
import { decodeUserId, encodeUserId } from '../utils/userId';
import { IMessageProtocol, EncryptedMessage } from '../api/messageProtocol';
import {
  SessionStatus,
  SendMessageOutput,
} from '../assets/generated/wasm/gossip_wasm';
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
import { DiscussionService } from './discussion';
import { sessionStatusToString } from '../wasm/session';
import { Logger } from '../utils/logs';
import { GossipSdkEvents } from '../types/events';
import { SdkConfig, defaultSdkConfig } from '../config/sdk';

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
  private db: GossipDatabase;
  private messageProtocol: IMessageProtocol;
  private session: SessionModule;
  private discussionService: DiscussionService;
  private events: GossipSdkEvents;
  private config: SdkConfig;

  constructor(
    db: GossipDatabase,
    messageProtocol: IMessageProtocol,
    session: SessionModule,
    discussionService: DiscussionService,
    events: GossipSdkEvents = {},
    config: SdkConfig = defaultSdkConfig
  ) {
    this.db = db;
    this.messageProtocol = messageProtocol;
    this.session = session;
    this.discussionService = discussionService;
    this.events = events;
    this.config = config;
  }

  async fetchMessages(): Promise<MessageResult> {
    const log = logger.forMethod('fetchMessages');

    try {
      if (!this.session) throw new Error('Session module not initialized');

      let previousSeekers = new Set<string>();
      let iterations = 0;
      let newMessagesCount = 0;
      let seekers: Uint8Array[] = [];

      while (true) {
        seekers = this.session.getMessageBoardReadKeys();
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
      const discussion = await this.db.getDiscussionByOwnerAndContact(
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

      const id = await this.db.transaction(
        'rw',
        this.db.messages,
        this.db.discussions,
        async () => {
          const id = await this.db.messages.add({
            ownerUserId,
            contactUserId: discussion.contactUserId,
            content: message.content,
            type: message.type,
            direction: MessageDirection.INCOMING,
            status: MessageStatus.DELIVERED,
            timestamp: message.sentAt,
            metadata: {},
            seeker: message.seeker, // Store the seeker of the incoming message
            encryptedMessage: message.encryptedMessage, // Store the ciphertext of the incoming message
            replyTo: message.replyTo
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
              : undefined,

            forwardOf: message.forwardOf
              ? {
                  originalContent: message.forwardOf.originalContent,
                  originalSeeker: message.forwardOf.originalSeeker,
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
      storedIds.push(id);

      // Emit event for new message
      if (this.events.onMessageReceived) {
        const storedMessage = await this.db.messages.get(id);
        if (storedMessage) {
          this.events.onMessageReceived(storedMessage);
        }
      }
    }

    return storedIds;
  }

  async findMessageBySeeker(
    seeker: Uint8Array,
    ownerUserId: string
  ): Promise<Message | undefined> {
    return await this.db.messages
      .where('[ownerUserId+seeker]')
      .equals([ownerUserId, seeker])
      .first();
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

    // Query for messages from same sender with same content within time window
    const existing = await this.db.messages
      .where('[ownerUserId+contactUserId]')
      .equals([ownerUserId, contactUserId])
      .and(
        msg =>
          msg.direction === MessageDirection.INCOMING &&
          msg.content === content &&
          msg.timestamp >= windowStart &&
          msg.timestamp <= windowEnd
      )
      .first();

    return existing !== undefined;
  }

  private async acknowledgeMessages(
    seekers: Set<string>,
    userId: string
  ): Promise<void> {
    if (seekers.size === 0) return;

    const updatedCount = await this.db.messages
      .where('[ownerUserId+direction+status]')
      .equals([userId, MessageDirection.OUTGOING, MessageStatus.SENT])
      .filter(
        message =>
          message.seeker !== undefined &&
          seekers.has(encodeToBase64(message.seeker))
      )
      .modify({ status: MessageStatus.DELIVERED });

    // After marking messages as DELIVERED, clean up DELIVERED keep-alive messages
    await this.db.messages
      .where({
        ownerUserId: userId,
        status: MessageStatus.DELIVERED,
        type: MessageType.KEEP_ALIVE,
      })
      .delete();

    if (updatedCount > 0) {
      logger
        .forMethod('acknowledgeMessages')
        .info(`acknowledged ${updatedCount} messages`);
    }
  }

  async sendMessage(message: Message): Promise<SendMessageResult> {
    const log = logger.forMethod('sendMessage');
    log.info('sending message', {
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

    const discussion = await this.db.getDiscussionByOwnerAndContact(
      message.ownerUserId,
      message.contactUserId
    );
    if (!discussion) {
      return { success: false, error: 'Discussion not found' };
    }

    const sessionStatus = this.session.peerSessionStatus(peerId);

    // Check for session states that require renewal (session is truly lost)
    // Per spec: when session is lost, queue message as WAITING_SESSION and trigger auto-renewal
    const needsRenewalStatuses = [
      SessionStatus.UnknownPeer,
      SessionStatus.NoSession,
      SessionStatus.Killed,
      // Note: PeerRequested is NOT included - it means peer sent us an announcement
      // and we should accept it, not trigger renewal (which would create a race condition)
    ];

    if (needsRenewalStatuses.includes(sessionStatus)) {
      // Add message as WAITING_SESSION - it will be sent when session becomes Active
      const messageId = await this.db.addMessage({
        ...message,
        status: MessageStatus.WAITING_SESSION,
      });

      log.info('session lost, queuing message as WAITING_SESSION', {
        sessionStatus: sessionStatusToString(sessionStatus),
        messageId,
      });

      // Trigger auto-renewal (per spec: call create_session when session is lost)
      this.events.onSessionRenewalNeeded?.(message.contactUserId);

      const queuedMessage = {
        ...message,
        id: messageId,
        status: MessageStatus.WAITING_SESSION,
      };

      // Return success=true because the message is queued and will be sent later
      // This matches the spec where messages in WAITING_SESSION are valid queue items
      return {
        success: true,
        message: queuedMessage,
      };
    }

    // PeerRequested: peer sent us an announcement, we need to accept/respond
    // Queue the message but trigger accept flow, not renewal
    if (sessionStatus === SessionStatus.PeerRequested) {
      const messageId = await this.db.addMessage({
        ...message,
        status: MessageStatus.WAITING_SESSION,
      });

      log.info('peer requested session, queuing message - need to accept', {
        sessionStatus: sessionStatusToString(sessionStatus),
        messageId,
      });

      // Trigger accept flow (different from renewal - we respond to their announcement)
      this.events.onSessionAcceptNeeded?.(message.contactUserId);

      return {
        success: true,
        message: {
          ...message,
          id: messageId,
          status: MessageStatus.WAITING_SESSION,
        },
      };
    }

    // Serialize message content (handle replies)
    const serializeMessageResult = await this.serializeMessage(message);
    if (!serializeMessageResult.success) {
      return {
        success: false,
        error: serializeMessageResult.error,
      };
    }
    log.info('message serialized', {
      serializedContent: serializeMessageResult.data,
    });
    message.serializedContent = serializeMessageResult.data;

    // Check if we can send messages on this discussion
    const isUnstable = !(await this.discussionService.isStableState(
      message.ownerUserId,
      message.contactUserId
    ));
    const isSelfRequested = sessionStatus === SessionStatus.SelfRequested;

    // Per spec: if session is SelfRequested or discussion unstable, queue as WAITING_SESSION
    if (isUnstable || isSelfRequested) {
      const messageId = await this.db.addMessage({
        ...message,
        status: MessageStatus.WAITING_SESSION,
      });

      // Clear console log for debugging
      console.warn(
        `[SendMessage] WAITING_SESSION - isUnstable=${isUnstable}, isSelfRequested=${isSelfRequested}, sessionStatus=${sessionStatusToString(sessionStatus)}`
      );

      log.info('discussion/session not ready, queuing as WAITING_SESSION', {
        isUnstable,
        isSelfRequested,
        sessionStatus: sessionStatusToString(sessionStatus),
      });

      return {
        success: true,
        message: {
          ...message,
          id: messageId,
          status: MessageStatus.WAITING_SESSION,
        },
      };
    }

    const messageId = await this.db.addMessage({
      ...message,
      status: MessageStatus.SENDING,
    });

    let sendOutput: SendMessageOutput | undefined;
    try {
      if (sessionStatus !== SessionStatus.Active) {
        throw new Error(
          `Session not active: ${sessionStatusToString(sessionStatus)}`
        );
      }

      // CRITICAL: await session.sendMessage to ensure session state is persisted
      // before the encrypted message is sent to the network
      sendOutput = await this.session.sendMessage(
        peerId,
        message.serializedContent!
      );
      if (!sendOutput) throw new Error('sendMessage returned null');
    } catch (error) {
      await this.db.transaction(
        'rw',
        this.db.messages,
        this.db.discussions,
        async () => {
          await this.db.messages.update(messageId, {
            status: MessageStatus.FAILED,
          });
          await this.db.discussions.update(discussion.id, {
            status: DiscussionStatus.BROKEN,
          });
        }
      );

      log.error('encryption failed → discussion marked broken', error);
      const failedMessage = {
        ...message,
        id: messageId,
        status: MessageStatus.FAILED,
      };
      this.events.onMessageFailed?.(
        failedMessage,
        error instanceof Error ? error : new Error('Session error')
      );

      return {
        success: false,
        error: 'Session error',
        message: failedMessage,
      };
    }

    try {
      await this.messageProtocol.sendMessage({
        seeker: sendOutput.seeker,
        ciphertext: sendOutput.data,
      });

      await this.db.messages.update(messageId, {
        status: MessageStatus.SENT,
        seeker: sendOutput.seeker,
        encryptedMessage: sendOutput.data,
      });

      const sentMessage = {
        ...message,
        id: messageId,
        status: MessageStatus.SENT,
      };
      this.events.onMessageSent?.(sentMessage);

      return {
        success: true,
        message: sentMessage,
      };
    } catch (error) {
      await this.db.messages.update(messageId, {
        status: MessageStatus.FAILED,
        seeker: sendOutput.seeker,
        encryptedMessage: sendOutput.data,
      });

      log.error('network send failed → will retry later', error);
      const failedMessage = {
        ...message,
        id: messageId,
        status: MessageStatus.FAILED,
      };
      this.events.onMessageFailed?.(
        failedMessage,
        error instanceof Error ? error : new Error('Network send failed')
      );

      return {
        success: false,
        error: 'Network send failed',
        message: failedMessage,
      };
    }
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

    const successfullySent: number[] = [];
    let totalProcessed = 0;

    for (const [contactId, retryMessages] of messages.entries()) {
      const peerId = decodeUserId(contactId);
      totalProcessed += retryMessages.length;

      for (const msg of retryMessages) {
        /* If the message has already been encrypted by sessionManager, resend it */
        if (msg.encryptedMessage && msg.seeker) {
          log.info(
            'message has already been encrypted by sessionManager with seeker',
            {
              messageContent: msg.content,
              seeker: encodeToBase64(msg.seeker),
            }
          );
          try {
            await this.messageProtocol.sendMessage({
              seeker: msg.seeker,
              ciphertext: msg.encryptedMessage,
            });
            successfullySent.push(msg.id!);
            log.info('message has been resent successfully on the network', {
              messageContent: msg.content,
            });
          } catch (error) {
            log.error('failed to resend message', {
              error: error,
              messageId: msg.id,
              messageContent: msg.content,
            });
          }

          /* If the message has not been encrypted by sessionManager, encrypt it and resend it */
        } else {
          log.info('message has not been encrypted by sessionManager', {
            messageContent: msg.content,
          });
          const status = this.session.peerSessionStatus(peerId);
          log.info('session status for peer', {
            peerId: encodeUserId(peerId),
            sessionStatus: sessionStatusToString(status),
          });
          /* If the session is waiting for peer acceptance, don't attempt to resend messages in this discussion
          because we don't have the peer's next seeker yet*/
          if (status === SessionStatus.SelfRequested) {
            log.info('skipping resend — waiting for peer acceptance', {
              contactId,
            });
            break;
          }

          /*
          If session manager encryption fails for a message N, we can't send next N+1, N+2, ... messages in the discussion.
          If the message N+1 is passed with success in session.sendMessage() before passing the message N,
          message N would be considered as posterior to message N+1, which is not correct.
          So if a message can't be encrypted in session.sendMessage() because of error session status,
          we should break the loop and trigger auto-renewal.
          */
          const needsRenewalStatuses = [
            SessionStatus.Killed,
            SessionStatus.Saturated,
            SessionStatus.NoSession,
            SessionStatus.UnknownPeer,
            // Note: PeerRequested is NOT included - it means peer sent us an announcement
            // and we should accept it, not trigger renewal
          ];

          if (needsRenewalStatuses.includes(status)) {
            // Per spec: trigger auto-renewal instead of marking as BROKEN
            // Messages stay in WAITING_SESSION/FAILED and will be processed when session is Active
            log.info('session lost during resend, triggering renewal', {
              sessionStatus: sessionStatusToString(status),
              contactId,
            });
            this.events.onSessionRenewalNeeded?.(contactId);
            break;
          }

          // PeerRequested: peer sent us an announcement, need to accept
          if (status === SessionStatus.PeerRequested) {
            log.info(
              'peer requested session during resend, triggering accept',
              {
                sessionStatus: sessionStatusToString(status),
                contactId,
              }
            );
            this.events.onSessionAcceptNeeded?.(contactId);
            break;
          }

          if (status !== SessionStatus.Active) {
            log.warn('session not active — stopping resend', {
              sessionStatus: sessionStatusToString(status),
              contactId,
            });
            break;
          }

          // if the message has not been serialized, serialize it
          let serializedContent = msg.serializedContent;
          if (!serializedContent) {
            log.info('message not serialized yet — serializing it', {
              messageContent: msg.content,
            });
            const serializeResult = await this.serializeMessage(msg);
            if (!serializeResult.success) {
              log.error('serialization failed during resend', {
                error: serializeResult.error,
              });
              break;
            }
            serializedContent = serializeResult.data;
            log.info('message serialized', {
              messageContent: msg.content,
              serializedContent: serializedContent,
            });
          }

          const sendOutput = await this.session.sendMessage(
            peerId,
            serializedContent
          );
          if (!sendOutput) {
            log.error('session manager failed to send message', {
              messageId: msg.id,
              messageContent: msg.content,
            });
            break;
          }

          await this.db.messages.update(msg.id, {
            seeker: sendOutput.seeker,
            encryptedMessage: sendOutput.data,
          });

          try {
            await this.messageProtocol.sendMessage({
              seeker: sendOutput.seeker,
              ciphertext: sendOutput.data,
            });
            successfullySent.push(msg.id!);
          } catch (error) {
            log.error('network send failed during resend', error);
          }
        }
      }
    }

    if (successfullySent.length > 0) {
      await this.db.transaction('rw', this.db.messages, async () => {
        await Promise.all(
          successfullySent.map(id =>
            this.db.messages.update(id, { status: MessageStatus.SENT })
          )
        );
      });
    }

    log.info('resend completed', {
      contacts: messages.size,
      messagesProcessed: totalProcessed,
      successfullySent: successfullySent.length,
    });
  }

  /**
   * Process messages that are waiting for an active session.
   * Called when a session becomes Active to send queued messages.
   * Per spec: when session becomes Active, encrypt and send WAITING_SESSION messages.
   *
   * @param contactUserId - The contact whose session became active
   * @returns Number of messages successfully sent
   */
  async processWaitingMessages(contactUserId: string): Promise<number> {
    const log = logger.forMethod('processWaitingMessages');
    const ownerUserId = this.session.userIdEncoded;
    const peerId = decodeUserId(contactUserId);

    // Check session is actually active
    const sessionStatus = this.session.peerSessionStatus(peerId);
    if (sessionStatus !== SessionStatus.Active) {
      log.warn('cannot process waiting messages - session not active', {
        sessionStatus: sessionStatusToString(sessionStatus),
        contactUserId,
      });
      return 0;
    }

    // Get all WAITING_SESSION messages for this contact, ordered by timestamp
    const waitingMessages = await this.db.messages
      .where('[ownerUserId+contactUserId+status]')
      .equals([ownerUserId, contactUserId, MessageStatus.WAITING_SESSION])
      .sortBy('timestamp');

    if (waitingMessages.length === 0) {
      return 0;
    }

    log.info('processing waiting messages', {
      count: waitingMessages.length,
      contactUserId,
    });

    let successCount = 0;

    for (const msg of waitingMessages) {
      // Serialize if not already done
      let serializedContent = msg.serializedContent;
      if (!serializedContent) {
        const serializeResult = await this.serializeMessage(msg);
        if (!serializeResult.success) {
          log.error('failed to serialize waiting message', {
            messageId: msg.id,
            error: serializeResult.error,
          });
          // Mark as FAILED since we can't serialize
          await this.db.messages.update(msg.id!, {
            status: MessageStatus.FAILED,
          });
          continue;
        }
        serializedContent = serializeResult.data;
      }

      // Encrypt with session manager (await to ensure persistence before network send)
      const sendOutput = await this.session.sendMessage(
        peerId,
        serializedContent
      );
      if (!sendOutput) {
        log.error('session manager failed to encrypt waiting message', {
          messageId: msg.id,
        });
        // Don't mark as FAILED - session might have changed, retry later
        break;
      }

      // Update message with encrypted data
      await this.db.messages.update(msg.id!, {
        status: MessageStatus.SENDING,
        seeker: sendOutput.seeker,
        encryptedMessage: sendOutput.data,
        serializedContent,
      });

      // Send over network
      try {
        await this.messageProtocol.sendMessage({
          seeker: sendOutput.seeker,
          ciphertext: sendOutput.data,
        });

        await this.db.messages.update(msg.id!, {
          status: MessageStatus.SENT,
        });

        successCount++;
        this.events.onMessageSent?.({
          ...msg,
          status: MessageStatus.SENT,
        });
      } catch (error) {
        log.error('network send failed for waiting message', {
          messageId: msg.id,
          error,
        });
        // Keep as SENDING - will be retried by resendMessages
        await this.db.messages.update(msg.id!, {
          status: MessageStatus.FAILED,
        });
      }
    }

    log.info('processed waiting messages', {
      total: waitingMessages.length,
      sent: successCount,
    });

    return successCount;
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
}
