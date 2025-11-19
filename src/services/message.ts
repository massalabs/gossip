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
import { strToBytes } from '@massalabs/massa-web3';
import { RetryMessages } from '../stores/messageStore';
import {
  SessionStatus,
  UserSecretKeys,
} from '../assets/generated/wasm/gossip_wasm';
import { SessionModule } from '../wasm';
import {
  serializeRegularMessage,
  serializeReplyMessage,
  deserializeMessage,
} from '../utils/messageSerialization';
import { encodeToBase64 } from '../utils/base64';
import { isAppInForeground } from '../utils/appState';

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

      let seekers: Uint8Array[] = [];

      while (true) {
        seekers = session.getMessageBoardReadKeys();
        const seekerStrings = seekers.map(s => encodeToBase64(s));
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

        const { decrypted: decryptedMessages, acknowledgedSeekers } =
          this.decryptMessages(encryptedMessages, session, ourSk);

        const storedMessagesIds = await this.storeDecryptedMessages(
          decryptedMessages,
          userProfile.userId
        );

        console.log('acknowledged seekers:', acknowledgedSeekers);
        await this.acknowledgeMessages(acknowledgedSeekers);

        newMessagesCount += storedMessagesIds.length;
        iterations += 1;
        // Small delay to avoid tight loop
        await sleep(100);
      }

      // Update active seekers table after sync completes.
      // Store the final seekers after the fetch loop completes.
      // These seekers are written to BackgroundRunner storage
      // so the background runner can use them for background sync.
      //
      // IMPORTANT: Only update seekers when app is in foreground.
      // When app is in background, the background runner is using the stored seekers,
      // and we shouldn't overwrite them until the app comes back to foreground.
      try {
        // Check if app is in foreground before updating seekers.
        const foreground = await isAppInForeground();

        if (foreground) {
          await db.setActiveSeekers(seekers);
        }
      } catch (error) {
        // Log error but don't fail the entire fetch operation
        console.error('Failed to update active seekers:', error);
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

  /**
   * Decrypts an array of encrypted messages and returns both the decrypted message objects
   * and a list of seekers that were successfully acknowledged.
   */
  private decryptMessages(
    encrypted: EncryptedMessage[],
    session: SessionModule,
    ourSk: UserSecretKeys
  ): { decrypted: Decrypted[]; acknowledgedSeekers: Set<string> } {
    const decrypted: Decrypted[] = [];
    const acknowledgedSeekers: Set<string> = new Set();
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

          console.log(
            'acknowledged seeker for message ',
            out.message,
            ':',
            Buffer.from(msg.seeker).toString('base64')
          );
          acknowledgedSeekers.add(Buffer.from(msg.seeker).toString('base64')); // to base64 for efficient comparison
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
    return { decrypted, acknowledgedSeekers };
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
              encodeToBase64(message.replyTo.originalSeeker)
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
  /*
   * Acknowledge messages by updating their status to 'delivered' based on seekers.
   * Updates all messages that have a sessionMessageInfo.encryptedMessage.seeker matching
   * any seeker in the provided array. Uses a single transaction for performance.
   * @param seekers Array of Uint8Array seekers to match against
   */
  private async acknowledgeMessages(seekers: Set<string>): Promise<void> {
    if (seekers.size === 0) return;

    // Get all messages that have sessionMessageInfo
    // We need to filter in memory since Dexie doesn't support nested field queries
    const { userProfile } = useAccountStore.getState();
    if (!userProfile?.userId) return;

    const acknowledgedMessages = await db.messages
      .where('ownerUserId')
      .equals(userProfile.userId)
      .filter(msg => {
        // Only process messages that have sessionMessageInfo
        if (!msg.sessionMessageInfo?.encryptedMessage?.seeker) {
          return false;
        }
        // Check if the seeker matches any in the seekers array
        const msgSeekerBase64 = Buffer.from(
          msg.sessionMessageInfo.encryptedMessage.seeker
        ).toString('base64');
        return seekers.has(msgSeekerBase64);
      })
      .toArray();

    if (acknowledgedMessages.length === 0) return;

    // Update all matching messages in a single transaction
    await db.transaction('rw', db.messages, async () => {
      await Promise.all(
        acknowledgedMessages.map(msg =>
          db.messages.update(msg.id!, { status: 'delivered' })
        )
      );
    });
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

    const session = useAccountStore.getState().session;
    if (!session) throw new Error('Session module not initialized');
    const peerId = decodeUserId(message.contactUserId);

    // Ensure DB reflects that this message is being (re)sent
    await db.messages.update(message.id, { status: 'sending' });
    // add discussionId to the content prefix
    const contentBytes = strToBytes(message.content);

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

    const sendOutput = session.sendMessage(peerId, contentBytes);

    if (!sendOutput) throw new Error('WASM sendMessage returned null');

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

      await db.messages.update(message.id, {
        status: 'sent',
        sessionMessageInfo: {
          encryptedMessage: {
            seeker: sendOutput.seeker,
            ciphertext: sendOutput.data,
          },
          lastRetryAt: new Date(),
        },
      });

      return {
        success: true,
        message: { ...message, id: message.id, status: 'sent' },
      };
    } catch (error) {
      await db.messages.update(message.id, {
        status: 'failed',
        sessionMessageInfo: {
          encryptedMessage: {
            seeker: sendOutput.seeker,
            ciphertext: sendOutput.data,
          },
          lastRetryAt: new Date(),
        },
      });
      // if (sendOutput) {
      //   const discussion = await db.getDiscussionByOwnerAndContact(
      //     message.ownerUserId,
      //     message.contactUserId
      //   );
      //   if (!discussion)
      //     throw new Error(
      //       'Could not send message after session manager and could not save failed encrypted message because discussion not found'
      //     );
      //   await db.discussions.update(discussion.id, {
      //     failedEncryptedMessage: {
      //       seeker: sendOutput.seeker,
      //       ciphertext: sendOutput.data,
      //     },
      //   });
      // }
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

  async resendMessages(messages: Map<string, RetryMessages[]>) {
    const session = useAccountStore.getState().session;

    const messageSent: number[] = [];
    for (const [contactId, retryMessages] of messages.entries()) {
      const peerId = decodeUserId(contactId);
      console.log('resending messages for contact:', contactId);
      for (const retryMessage of retryMessages) {
        console.log(
          'sessionMessageInfo for message:',
          retryMessage.id,
          ':',
          retryMessage.sessionMessageInfo
        );
        if (retryMessage.sessionMessageInfo) {
          // if the message has already been encrypted by sessionManager, resend it
          try {
            await this.messageProtocol.sendMessage(
              retryMessage.sessionMessageInfo.encryptedMessage
            );
            messageSent.push(retryMessage.id);
          } catch (error) {
            console.error(
              `Failed to resend message ${retryMessage.id}: ${error instanceof Error ? error.message : error}`
            );
          }
        } else {
          // if the message has not been encrypted by sessionManager, encrypt it and resend it
          /* 
          If session manager encryption fails for a message N, we can't send next N+1, N+2, ... messages in the discussion.
          If the message N+1 is passed with success in session.sendMessage() before passing the message N,
          message N would be considered as posterior to message N+1, which is not correct.
          So if a message fails in session.sendMessage(), we should break the loop and not send any other message in the discussion.
          */
          if (!session) {
            console.error(`resendMessages: Session manager not initialized`);
            break;
          }
          const status = session.peerSessionStatus(peerId);
          if (status !== SessionStatus.Active) {
            console.error(
              `Session with peer ${peerId.toString()} not active, got status: ${status}`
            );
            break;
          }

          const sendOutput = session.sendMessage(
            peerId,
            strToBytes(retryMessage.content)
          );
          if (!sendOutput) {
            console.error(
              `Session manager failed to send message ${retryMessage.id}`
            );
            break;
          }

          try {
            await this.messageProtocol.sendMessage({
              seeker: sendOutput.seeker,
              ciphertext: sendOutput.data,
            });
          } catch (error) {
            /* Message has been encrypted by session manager and a new seeker has been generated, but failed to send on the network*/
            console.error(
              `Failed to send message ${retryMessage.id}: ${error instanceof Error ? error.message : error}`
            );
            await db.messages.update(retryMessage.id, {
              sessionMessageInfo: {
                encryptedMessage: {
                  seeker: sendOutput.seeker,
                  ciphertext: sendOutput.data,
                },
                lastRetryAt: new Date(),
              },
            });
            break;
          }
          messageSent.push(retryMessage.id);
        }
      }
    }

    // Batch update statuses of all messages in messageSent to 'sent' in a Dexie transaction
    if (messageSent.length > 0) {
      await db.transaction('rw', db.messages, async () => {
        await Promise.all(
          messageSent.map(id => db.messages.update(id, { status: 'sent' }))
        );
      });
    }
  }
}

export const messageService = new MessageService(createMessageProtocol());
