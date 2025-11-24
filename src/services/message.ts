/**
 * Message Reception Service
 *
 * Handles fetching encrypted messages from the protocol and decrypting them.
 * This service works both in the main app context and Service Worker context.
 */

import { db, Message } from '../db';
import { decodeUserId, encodeUserId } from '../utils/userId';
import {
  IMessageProtocol,
  createMessageProtocol,
  EncryptedMessage,
} from '../api/messageProtocol';
import { useAccountStore } from '../stores/accountStore';

import {
  SessionStatus,
  UserSecretKeys,
  SendMessageOutput,
} from '../assets/generated/wasm/gossip_wasm';
import { SessionModule } from '../wasm';
import {
  serializeRegularMessage,
  serializeReplyMessage,
  deserializeMessage,
} from '../utils/messageSerialization';
import { encodeToBase64 } from '../utils/base64';

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
  seeker: Uint8Array; // Seeker of the incoming message
  replyTo?: {
    originalContent: string;
    originalSeeker: Uint8Array;
  };
}

const LIMIT_FETCH_ITERATIONS = 30;

const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

export class MessageService {
  constructor(public readonly messageProtocol: IMessageProtocol) {}

  /**
   * Fetch new encrypted messages for a specific discussion
   * @returns Result with count of new messages fetched
   */
  async fetchMessages(): Promise<MessageResult> {
    try {
      const { session, ourSk, userProfile } = useAccountStore.getState();
      if (!session) throw new Error('Session module not initialized');
      if (!ourSk) throw new Error('WASM secret keys unavailable');
      if (!userProfile?.userId) throw new Error('No authenticated user');

      let previousSeekers: Set<string> = new Set();
      let iterations = 0;
      let newMessagesCount = 0;

      while (true) {
        const seekers = session.getMessageBoardReadKeys();
        const seekerStrings = seekers.map(s =>
          Buffer.from(s).toString('base64')
        );
        const currentSeekers = new Set(seekerStrings);

        const allSame =
          seekerStrings.length === previousSeekers.size &&
          [...seekerStrings].every(s => previousSeekers.has(s));

        if (allSame || iterations >= LIMIT_FETCH_ITERATIONS) {
          break;
        }

        const encryptedMessages =
          await this.messageProtocol.fetchMessages(seekers);
        previousSeekers = currentSeekers;

        if (encryptedMessages.length === 0) {
          continue;
        }

        const decryptedMessages = this.decryptMessages(
          encryptedMessages,
          session,
          ourSk
        );

        const storedMessagesIds = await this.storeDecryptedMessages(
          decryptedMessages,
          userProfile.userId
        );

        newMessagesCount += storedMessagesIds.length;
        iterations += 1;
        // Small delay to avoid tight loop
        await sleep(100);
      }

      return {
        success: true,
        newMessagesCount,
      };
    } catch (err) {
      return {
        success: false,
        newMessagesCount: 0,
        error: err instanceof Error ? err.message : 'Unknown error',
      };
    }
  }

  private decryptMessages(
    encrypted: EncryptedMessage[],
    session: SessionModule,
    ourSk: UserSecretKeys
  ): Decrypted[] {
    const decrypted: Decrypted[] = [];
    for (const msg of encrypted) {
      try {
        const out = session.feedIncomingMessageBoardRead(
          msg.seeker,
          msg.ciphertext,
          ourSk
        );
        if (!out) continue;

        // Deserialize message (handles both regular and reply)
        try {
          const deserialized = deserializeMessage(out.message);

          decrypted.push({
            content: deserialized.content,
            sentAt: new Date(Number(out.timestamp)),
            senderId: encodeUserId(out.user_id),
            seeker: msg.seeker,
            replyTo: deserialized.replyTo
              ? {
                  originalContent: deserialized.replyTo.originalContent,
                  originalSeeker: deserialized.replyTo.originalSeeker,
                }
              : undefined,
          });
        } catch (deserializationError) {
          console.error(
            'Message deserialization failed:',
            deserializationError,
            {
              seeker: encodeToBase64(msg.seeker),
              senderId: encodeUserId(out.user_id),
            }
          );
        }
      } catch (e) {
        console.error('Decrypt failed:', e);
      }
    }
    return decrypted;
  }

  private async storeDecryptedMessages(
    decrypted: Decrypted[],
    ownerUserId: string
  ): Promise<number[]> {
    if (!decrypted.length) return [];

    const ids = await Promise.all(
      decrypted.map(async message => {
        const discussion = await db.getDiscussionByOwnerAndContact(
          ownerUserId,
          message.senderId
        );
        if (!discussion) {
          // Skip messages without existing discussion: Should not happen normally
          console.error(
            'No discussion found for incoming message from',
            message.senderId
          );
          return undefined;
        }

        const isReply = !!message.replyTo?.originalContent;

        // Find the original message by seeker if this is a reply
        // This is used to determine whether to store originalContent as a fallback
        let replyToMessageId: number | undefined;
        if (isReply && message.replyTo?.originalSeeker) {
          const originalMessage = await this.findMessageBySeeker(
            message.replyTo.originalSeeker,
            ownerUserId
          );
          if (!originalMessage) {
            console.warn(
              'Original message not found for reply',
              Buffer.from(message.replyTo.originalSeeker).toString('base64')
            );
          }
          replyToMessageId = originalMessage?.id;
        }

        const id = await db.messages.add({
          ownerUserId,
          contactUserId: discussion.contactUserId,
          content: message.content,
          type: 'text' as const,
          direction: 'incoming' as const,
          status: 'delivered' as const,
          timestamp: message.sentAt,
          metadata: {},
          seeker: message.seeker, // Store the seeker of the incoming message
          replyTo:
            isReply && message.replyTo
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
        });
        const now = new Date();
        await db.discussions.update(discussion.id, {
          lastMessageId: id,
          lastMessageContent: message.content,
          lastMessageTimestamp: message.sentAt,
          updatedAt: now,
          lastSyncTimestamp: now,
          unreadCount: discussion.unreadCount + 1,
        });
        return id;
      })
    );
    // Filter out any undefined values (messages without a discussion)
    return ids.filter((id): id is number => typeof id === 'number');
  }

  /**
   * Find message by seeker (for matching replies)
   */
  async findMessageBySeeker(
    seeker: Uint8Array,
    ownerUserId: string
  ): Promise<Message | undefined> {
    // Use indexed compound query
    return await db.messages
      .where('[ownerUserId+seeker]')
      .equals([ownerUserId, seeker])
      .first();
  }

  /**
   * Create a text message, persist it as sending, send via protocol, and update status.
   * Returns the created message (with final status) on success/failure.
   */
  async sendMessage(message: Message): Promise<SendMessageResult> {
    if (!message.id) {
      return {
        success: false,
        error: 'Message must have an id before sending',
      };
    }

    let sendOutput: SendMessageOutput | undefined;

    try {
      const session = useAccountStore.getState().session;
      if (!session) throw new Error('Session module not initialized');
      const peerId = decodeUserId(message.contactUserId);

      // Ensure DB reflects that this message is being (re)sent
      await db.messages.update(message.id, { status: 'sending' });

      // Serialize message content (handle replies)
      let contentBytes: Uint8Array;
      if (message.replyTo?.originalSeeker) {
        // Find the original message by seeker
        const originalMessage = await this.findMessageBySeeker(
          message.replyTo.originalSeeker,
          message.ownerUserId
        );
        if (!originalMessage) {
          await db.messages.update(message.id, { status: 'failed' });
          return {
            success: false,
            error: 'Original message not found for reply',
            message: { ...message, status: 'failed' },
          };
        }

        // Serialize reply with type tag and seeker
        contentBytes = serializeReplyMessage(
          message.content,
          originalMessage.content,
          message.replyTo.originalSeeker
        );
      } else {
        // Regular message with type tag
        contentBytes = serializeRegularMessage(message.content);
      }

      // Validate peer ID length
      if (peerId.length !== 32) {
        await db.messages.update(message.id, { status: 'failed' });
        return {
          success: false,
          error: 'Invalid contact userId (must decode to 32 bytes)',
          message: { ...message, status: 'failed' },
        };
      }

      // Ensure session is active before sending
      const status = session.peerSessionStatus(peerId);

      if (status !== SessionStatus.Active) {
        const statusName =
          SessionStatus[status as unknown as number] ?? String(status);
        await db.messages.update(message.id, { status: 'failed' });
        return {
          success: false,
          error: `Session not ready: ${statusName}`,
          message: { ...message, status: 'failed' },
        };
      }

      sendOutput = session.sendMessage(peerId, contentBytes);

      if (!sendOutput) throw new Error('WASM sendMessage returned null');

      await this.messageProtocol.sendMessage({
        seeker: sendOutput.seeker,
        ciphertext: sendOutput.data,
      });

      // Store the seeker with the message
      await db.messages.update(message.id, {
        seeker: sendOutput.seeker,
        status: 'sent',
      });

      return {
        success: true,
        message: { ...message, id: message.id, status: 'sent' },
      };
    } catch (error) {
      await db.messages.update(message.id, { status: 'failed' });
      if (sendOutput) {
        const discussion = await db.getDiscussionByOwnerAndContact(
          message.ownerUserId,
          message.contactUserId
        );
        if (!discussion)
          throw new Error(
            'Could not send message after session manager and could not save failed encrypted message because discussion not found'
          );
        await db.discussions.update(discussion.id, {
          failedEncryptedMessage: {
            seeker: sendOutput.seeker,
            ciphertext: sendOutput.data,
          },
        });
      }
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Send failed',
        message: { ...message, status: 'failed' },
      };
    }
  }

  async resendMessage(message: Message): Promise<SendMessageResult> {
    const discussion = await db.getDiscussionByOwnerAndContact(
      message.ownerUserId,
      message.contactUserId
    );
    if (!discussion)
      return {
        success: false,
        error: 'Discussion not found',
        message: { ...message, status: 'failed' },
      };

    if (discussion.failedEncryptedMessage) {
      // If the message has already been encrypted by sessionManager, resend it
      try {
        // Optimistically update status. Ensure DB reflects that this message is being (re)sent
        await db.messages.update(message.id, { status: 'sending' });

        // Send the message
        await this.messageProtocol.sendMessage({
          seeker: discussion.failedEncryptedMessage.seeker,
          ciphertext: discussion.failedEncryptedMessage.ciphertext,
        });

        await db.messages.update(message.id, { status: 'sent' });

        // Update the discussion to remove the failed encrypted message
        await db.discussions.update(discussion.id, {
          failedEncryptedMessage: undefined,
        });

        return {
          success: true,
          message: { ...message, id: message.id, status: 'sent' },
        };
      } catch (error) {
        await db.messages.update(message.id, { status: 'failed' });

        return {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : 'Failed to resend message: ' + error,
          message: { ...message, status: 'failed' },
        };
      }
    } else {
      // If the message has not been encrypted by sessionManager, send it as if it were new
      return await this.sendMessage(message);
    }
  }
}

export const messageService = new MessageService(createMessageProtocol());
