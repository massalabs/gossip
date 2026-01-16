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
import { isDiscussionStableState } from './discussion';
import { sessionStatusToString } from '../wasm/session';
import { Logger } from '../utils/logs';
import { GossipSdkEvents } from '../types/events';

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

const LIMIT_FETCH_ITERATIONS = 30;
const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

const logger = new Logger('MessageService');

export class MessageService {
  private db: GossipDatabase;
  private messageProtocol: IMessageProtocol;
  private session: SessionModule;
  private events: GossipSdkEvents;

  constructor(
    db: GossipDatabase,
    messageProtocol: IMessageProtocol,
    session: SessionModule,
    events: GossipSdkEvents = {}
  ) {
    this.db = db;
    this.messageProtocol = messageProtocol;
    this.session = session;
    this.events = events;
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

        if (allSame || iterations >= LIMIT_FETCH_ITERATIONS) {
          if (iterations >= LIMIT_FETCH_ITERATIONS) {
            log.warn('fetch loop stopped due to max iterations', {
              iterations,
            });
          }
          break;
        }

        const encryptedMessages =
          await this.messageProtocol.fetchMessages(seekers);
        previousSeekers = currentSeekers;

        if (encryptedMessages.length === 0) {
          iterations++;
          await sleep(100);
          continue;
        }

        const { decrypted: decryptedMessages, acknowledgedSeekers } =
          this.decryptMessages(encryptedMessages);

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
        await sleep(100);
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

  private decryptMessages(encrypted: EncryptedMessage[]): {
    decrypted: Decrypted[];
    acknowledgedSeekers: Set<string>;
  } {
    const log = logger.forMethod('decryptMessages');

    const decrypted: Decrypted[] = [];
    const acknowledgedSeekers: Set<string> = new Set();

    for (const msg of encrypted) {
      try {
        const out = this.session.feedIncomingMessageBoardRead(
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

    if (sessionStatus === SessionStatus.PeerRequested) {
      return {
        success: false,
        error: 'Must accept peer request before sending messages',
      };
    }

    if (
      [SessionStatus.UnknownPeer, SessionStatus.NoSession].includes(
        sessionStatus
      )
    ) {
      return { success: false, error: 'No active session with peer' };
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
    const isUnstable = !(await isDiscussionStableState(
      message.ownerUserId,
      message.contactUserId,
      this.db
    ));
    const isSelfRequested = sessionStatus === SessionStatus.SelfRequested;

    if (isUnstable || isSelfRequested) {
      const messageId = await this.db.addMessage({
        ...message,
        status: MessageStatus.FAILED,
      });
      return {
        success: false,
        error: isUnstable
          ? 'Discussion is broken'
          : 'Waiting for peer acceptance',
        message: { ...message, id: messageId, status: MessageStatus.FAILED },
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

      sendOutput = this.session.sendMessage(peerId, message.serializedContent!);
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
          we should break the loop and not send any other message in the discussion.
          */
          if (
            status === SessionStatus.Killed ||
            status === SessionStatus.Saturated
          ) {
            await this.db.discussions
              .where('[ownerUserId+contactUserId]')
              .equals([msg.ownerUserId, contactId])
              .modify({
                status: DiscussionStatus.BROKEN,
              });
            log.error('session broken during resend', { status, contactId });
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

          const sendOutput = this.session.sendMessage(
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
}
