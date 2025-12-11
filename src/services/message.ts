/**
 * Message Reception Service
 *
 * Handles fetching encrypted messages from the protocol and decrypting them.
 * This service works both in the main app context and Service Worker context.
 */

import {
  db,
  DiscussionStatus,
  Message,
  MessageDirection,
  MessageStatus,
  MessageType,
} from '../db';
import { decodeUserId, encodeUserId } from '../utils/userId';
import {
  IMessageProtocol,
  EncryptedMessage,
  restMessageProtocol,
} from '../api/messageProtocol';
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
import { isAppInForeground } from '../utils/appState';
import { isDiscussionStableState } from './discussion';
import { sessionStatusToString } from '../wasm/session';

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

type SerializeMessageResult = {
  error?: string;
  contentBytes?: Uint8Array;
};

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
  private messageProtocol: IMessageProtocol;
  constructor(messageProtocol: IMessageProtocol) {
    this.messageProtocol = messageProtocol;
  }
  setMessageProtocol(messageProtocol: IMessageProtocol): void {
    this.messageProtocol = messageProtocol;
  }

  /**
   * Fetch new encrypted messages for a specific discussion
   * @returns Result with count of new messages fetched
   */
  async fetchMessages(
    userId: string,
    ourSk: UserSecretKeys,
    session: SessionModule
  ): Promise<MessageResult> {
    try {
      if (!session) throw new Error('Session module not initialized');
      if (!ourSk) throw new Error('WASM secret keys unavailable');
      if (!userId) throw new Error('No authenticated user');

      let previousSeekers: Set<string> = new Set();
      let iterations = 0;
      let newMessagesCount = 0;

      let seekers: Uint8Array[] = [];

      while (true) {
        seekers = session.getMessageBoardReadKeys();
        const seekerStrings = seekers.map(s => encodeToBase64(s));
        const currentSeekers = new Set(seekerStrings);
        //console.log('MessageService.fetchMessages: fetch messages from seekers:', currentSeekers);

        const allSame =
          seekerStrings.length === previousSeekers.size &&
          [...seekerStrings].every(s => previousSeekers.has(s));

        if (allSame || iterations >= LIMIT_FETCH_ITERATIONS) {
          break;
        }

        const encryptedMessages =
          await this.messageProtocol.fetchMessages(seekers);
        previousSeekers = currentSeekers;
        console.log(
          'MessageService.fetchMessages: retrieved encrypted messages:',
          encryptedMessages
        );

        if (encryptedMessages.length === 0) {
          continue;
        }

        const { decrypted: decryptedMessages, acknowledgedSeekers } =
          this.decryptMessages(encryptedMessages, session, ourSk);

        console.log(
          'MessageService.fetchMessages: decrypted messages:',
          decryptedMessages
        );
        const storedMessagesIds = await this.storeDecryptedMessages(
          decryptedMessages,
          userId
        );

        console.log(
          'MessageService.fetchMessages: acknowledged seekers:',
          acknowledgedSeekers
        );
        await this.acknowledgeMessages(acknowledgedSeekers, userId);

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

          out.acknowledged_seekers.forEach(seeker => {
            acknowledgedSeekers.add(encodeToBase64(seeker));
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
            'No discussion found for incoming message from senderId:',
            message.senderId,
            ', content:',
            message.content
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
              `Could not find original message with seeker ${encodeToBase64(message.replyTo.originalSeeker)} the message "${message.content}" want to reply to`
            );
          }
          replyToMessageId = originalMessage?.id;
        }

        const id = await db.messages.add({
          ownerUserId,
          contactUserId: discussion.contactUserId,
          content: message.content,
          type: MessageType.TEXT,
          direction: MessageDirection.INCOMING,
          status: MessageStatus.DELIVERED,
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
   * Updates all messages that have a encryptedMessage.seeker matching
   * any seeker in the provided array.
   * @param seekers Array of Uint8Array seekers to match against
   */
  private async acknowledgeMessages(
    seekers: Set<string>,
    userId: string
  ): Promise<void> {
    if (seekers.size === 0) return;

    // Get all messages that have encryptedMessage
    // We need to filter in memory since Dexie doesn't support nested field queries
    if (!userId) return;

    // Fetch all discussions to check for BROKEN status
    // const nonStableDiscussions = await getNonStableDiscussions(
    //   userProfile.userId
    // );
    // const nonStableDiscussionContactIds = new Set(
    //   nonStableDiscussions.map(d => d.contactUserId)
    // );

    // For each seeker in the seekers set
    // for (const seekerBase64 of seekers) {
    //   // Find the message whose encryptedMessage.seeker matches this seeker
    //   const msg = await db.messages
    //     .where({
    //       'ownerUserId': userProfile.userId,
    //       'direction': 'outgoing',
    //       'status': 'sent'
    //     })
    //     .filter(m => {
    //       if (!m.encryptedMessage?.seeker) return false;
    //       return Buffer.from(m.encryptedMessage.seeker).toString('base64') === seekerBase64;
    //     })
    //     .first();

    //   if (msg) {
    //     // For all messages with the same owner, contact, outgoing direction,
    //     // 'id' less than or equal to the found message, and status 'sent', mark as delivered
    //     await db.messages
    //       .where({
    //         'ownerUserId': msg.ownerUserId,
    //         'contactUserId': msg.contactUserId,
    //         'direction': 'outgoing',
    //         'status': 'sent'
    //       })
    //       .and(m => m.id !== undefined && m.id <= msg.id!)
    //       .modify({ status: 'delivered' });
    //   }
    // }

    /* Set all messages with encryptedMessage.seeker matching any seeker in the provided array to 'delivered' */
    await db.messages
      .where('[ownerUserId+direction+status]')
      .equals([userId, MessageDirection.OUTGOING, MessageStatus.SENT])
      .filter(msg => {
        /* Only process messages that have encryptedMessage and seeker
        This is if acknowledged message has been updated from SENT to FAILED in the case of session break.
         */
        if (!msg.encryptedMessage || !msg.seeker) {
          return false;
        }
        // Exclude messages from BROKEN discussions
        // if (nonStableDiscussionContactIds.has(msg.contactUserId)) {
        //   return false;
        // }
        // Check if the seeker matches any in the seekers array
        const msgSeekerBase64 = encodeToBase64(msg.seeker);
        return seekers.has(msgSeekerBase64);
      })
      .modify({ status: MessageStatus.DELIVERED });
  }

  /**
   * Create a text message, persist it as sending, send via protocol, and update status.
   * Returns the created message (with final status) on success/failure.
   */
  async sendMessage(
    message: Message,
    session: SessionModule
  ): Promise<SendMessageResult> {
    const peerId = decodeUserId(message.contactUserId);

    // Validate peer ID length
    if (peerId.length !== 32) {
      return {
        success: false,
        error: `Invalid contact userId ${peerId.toString()} (must decode to 32 bytes)`,
      };
    }

    const discussion = await db.getDiscussionByOwnerAndContact(
      message.ownerUserId,
      message.contactUserId
    );
    if (!discussion) {
      return {
        success: false,
        error: `Discussion with ownerUserId ${message.ownerUserId} and contactUserId ${message.contactUserId} not found`,
      };
    }

    // get session status for the peer
    const sessionStatus = session.peerSessionStatus(peerId);
    console.log(
      'MessageService.sendMessage: sessionStatus: ',
      sessionStatusToString(sessionStatus)
    );

    // If attempt to send msg while the peer request is not accepted, return error
    // The function should not be called in this case, but just in case.
    if (sessionStatus === SessionStatus.PeerRequested) {
      return {
        success: false,
        error: 'Must accept peer request before sending messages',
      };
    }

    // These cases should really not happen, but just in case.
    if (
      sessionStatus === SessionStatus.UnknownPeer ||
      sessionStatus === SessionStatus.NoSession
    ) {
      return {
        success: false,
        error: 'Session not active or unknown peer',
      };
    }

    // Serialize message content (handle replies)
    const serializeMessageResult = await this.serializeMessage(message);
    console.log(
      'MessageService.sendMessage: message serialized:',
      serializeMessageResult
    );
    if (serializeMessageResult.error) {
      return {
        success: false,
        error: serializeMessageResult.error,
      };
    }
    const contentBytes = serializeMessageResult.contentBytes!;
    message.serializedContent = contentBytes;

    /* If the discussion is broken or still in pending state waiting for peer acceptance ;
    add message to db but in failed state in order for it to be resent later when the discussion
    is reinitialized or accepted by the peer*/
    const isUnstableDiscussion = !(await isDiscussionStableState(
      message.ownerUserId,
      message.contactUserId
    ));
    const isSelfRequested = sessionStatus === SessionStatus.SelfRequested;
    if (isUnstableDiscussion || isSelfRequested) {
      // Persist to DB
      const messageId = await db.addMessage({
        ...message,
        status: MessageStatus.FAILED,
      });
      return {
        success: false,
        error: isUnstableDiscussion
          ? 'Discussion is broken'
          : 'Discussion is still in pending state waiting for peer acceptance',
        message: { ...message, id: messageId, status: MessageStatus.FAILED },
      };
    }

    // persist message to DB as sending
    const messageId = await db.addMessage({
      ...message,
      status: MessageStatus.SENDING,
    });
    console.log(
      `MessageService.sendMessage: message "${message.content}" persisted to DB as sending with id: ${messageId}`
    );

    // submit message into session manager to encrypt it and update next seeker
    let sendOutput: SendMessageOutput | undefined;

    try {
      if (sessionStatus !== SessionStatus.Active) {
        const statusName =
          SessionStatus[sessionStatus as unknown as number] ??
          String(sessionStatus);
        throw new Error(`Session not active: ${statusName}`);
      }

      sendOutput = session.sendMessage(peerId, contentBytes);

      if (!sendOutput) throw new Error('WASM sendMessage returned null');
      console.log(
        `MessageService.sendMessage: message "${message.content}" sent to session manager with seeker: ${encodeToBase64(sendOutput.seeker)}`
      );
    } catch (error) {
      /* If there is an error here, it means the session between user and the contact is broken.
      Update the discussion as broken and the message should be stored as failed
      in order to be resent later when the discussion is reinitiated
      */
      await db.transaction('rw', db.messages, db.discussions, () => {
        db.messages.update(messageId, { status: MessageStatus.FAILED });
        db.discussions.update(discussion.id, {
          status: DiscussionStatus.BROKEN,
        });
      });

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Session manager error',
        message: { ...message, id: messageId, status: MessageStatus.FAILED },
      };
    }

    /* Broadcast message to the network */
    try {
      await this.messageProtocol.sendMessage({
        seeker: sendOutput.seeker,
        ciphertext: sendOutput.data,
      });

      await db.messages.update(messageId, {
        status: MessageStatus.SENT,
        seeker: sendOutput.seeker,
        encryptedMessage: sendOutput.data,
      });

      return {
        success: true,
        message: { ...message, id: messageId, status: MessageStatus.SENT },
      };
    } catch (error) {
      /* If there is an error here, it means the message has been encrypted and acknowledged by session manager but 
      could not be broadcasted on the network.
      Update the message as failed and store the encrypted message returned by session manager in order to resend it later.
      */
      await db.messages.update(messageId, {
        status: MessageStatus.FAILED,
        seeker: sendOutput.seeker,
        encryptedMessage: sendOutput.data,
      });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Send failed',
        message: { ...message, id: messageId, status: MessageStatus.FAILED },
      };
    }
  }

  private async serializeMessage(
    message: Message
  ): Promise<SerializeMessageResult> {
    if (message.replyTo?.originalSeeker) {
      // Find the original message by seeker
      const originalMessage = await this.findMessageBySeeker(
        message.replyTo.originalSeeker,
        message.ownerUserId
      );
      console.log(
        `MessageService.serializeMessage: message "${message.content}" reply to message: "${originalMessage?.content}"`
      );
      if (!originalMessage) {
        await db.messages.update(message.id, { status: MessageStatus.FAILED });
        return {
          error: 'Original message not found for reply',
        };
      }

      // Serialize reply with type tag and seeker
      return {
        contentBytes: serializeReplyMessage(
          message.content,
          originalMessage.content,
          message.replyTo.originalSeeker
        ),
      };
    } else {
      // Regular message with type tag
      return {
        contentBytes: serializeRegularMessage(message.content),
      };
    }
  }

  /**
   * Attempts to resend failed messages (with status FAILED) for multiple contacts, typically after network or session errors.
   *
   * For each contact/user:
   *   - Iterates through all retryable messages associated with that contact, in order.
   *   - If a message has already been encrypted (has `encryptedMessage` and `seeker`), tries to re-send it over the network.
   *   - If a message has NOT been encrypted, attempts to encrypt and send it using the session manager.
   *     - If encryption (not broadcasting on the network) for a message fails, stops further resending for that contact to preserve message order.
   *     - If sending succeeds, updates the message status in the DB.
   *
   * Notes:
   * - Ensures strict message ordering for each discussion: if an earlier message encryption via session manager fails, no later messages are encrypted and sent for that contact.
   * - Designed for use by hooks such as `useResendFailedBlobs` for automatic retry of failed messages.
   *
   * @param messages - A Map from contactUserId to an array of messages to be retried for that contact.
   * @param session - The cryptographic session module to use for encryption and retransmission.
   * @returns Promise<void>
   */
  async resendMessages(
    messages: Map<string, Message[]>,
    session: SessionModule
  ) {
    const messageSent: number[] = [];
    for (const [contactId, retryMessages] of messages.entries()) {
      const peerId = decodeUserId(contactId);
      console.log(
        `MessageService.resendMessages: resending messages for contact ${contactId} with peerId: ${peerId.toString()}`
      );
      for (const retryMessage of retryMessages) {
        console.log(
          `MessageService.resendMessages: resending message "${retryMessage.content}" with id: ${retryMessage.id!} from ${retryMessage.ownerUserId} to ${retryMessage.contactUserId}`
        );
        if (retryMessage.encryptedMessage && retryMessage.seeker) {
          // if the message has already been encrypted by sessionManager, resend it
          console.log(
            `MessageService.resendMessages: message "${retryMessage.content}" has already been encrypted by sessionManager with seeker: ${encodeToBase64(retryMessage.seeker)}`
          );
          try {
            await this.messageProtocol.sendMessage({
              seeker: retryMessage.seeker,
              ciphertext: retryMessage.encryptedMessage,
            });
            messageSent.push(retryMessage.id!);
            console.log(
              `MessageService.resendMessages: message "${retryMessage.content}" has been resend successfully on the network`
            );
          } catch (error) {
            console.error(
              `Failed to resend message ${retryMessage.id!}: ${error instanceof Error ? error.message : error}`
            );
          }
        } else {
          // if the message has not been encrypted by sessionManager, encrypt it and resend it

          console.log(
            `MessageService.resendMessages: message "${retryMessage.content}" has not been encrypted by sessionManager`
          );
          if (!session) {
            console.error(`resendMessages: Session manager not initialized`);
            break;
          }
          const status = session.peerSessionStatus(peerId);
          console.log(
            `MessageService.resendMessages: session status for peer ${peerId.toString()}: ${sessionStatusToString(status)}`
          );
          /* If the session is waiting for peer acceptance, don't attempt to resend messages in this discussion
          because we don't have the peer's next seeker yet*/
          if (status === SessionStatus.SelfRequested) break;

          /* 
          If session manager encryption fails for a message N, we can't send next N+1, N+2, ... messages in the discussion.
          If the message N+1 is passed with success in session.sendMessage() before passing the message N,
          message N would be considered as posterior to message N+1, which is not correct.
          So if a message fails in session.sendMessage(), we should break the loop and not send any other message in the discussion.
          */
          if (
            status === SessionStatus.Killed ||
            status === SessionStatus.Saturated
          ) {
            db.discussions
              .where('[ownerUserId+contactUserId]')
              .equals([retryMessage.ownerUserId, contactId])
              .modify({
                status: DiscussionStatus.BROKEN,
              });
            console.error(
              `Session with peer ${peerId.toString()} is broken with status ${sessionStatusToString(status)}`
            );
            break;
          }

          if (status !== SessionStatus.Active) {
            console.error(
              `Session with peer ${peerId.toString()} has status ${sessionStatusToString(status)}`
            );

            break;
          }

          // if the message has not been serialized, serialize it
          let serializedContent = retryMessage.serializedContent;
          if (!serializedContent) {
            console.log(
              `MessageService.resendMessages: message "${retryMessage.content}" has not been serialized yet. Serialize it now`
            );
            const serializeResult = await this.serializeMessage(retryMessage);
            if (serializeResult.error) {
              console.error(serializeResult.error);
              break;
            }
            serializedContent = serializeResult.contentBytes!;
          }

          console.log(
            `MessageService.resendMessages: message "${retryMessage.content}" has been serialized to ${serializedContent}. Encrypt it with session manager`
          );
          const sendOutput = session.sendMessage(peerId, serializedContent);
          if (!sendOutput) {
            console.error(
              `Session manager failed to send message ${retryMessage.id}`
            );
            break;
          }

          await db.messages.update(retryMessage.id, {
            seeker: sendOutput.seeker,
            encryptedMessage: sendOutput.data,
          });
          console.log(
            `MessageService.resendMessages: message "${retryMessage.content}" has been encrypted by sessionManager with seeker: ${encodeToBase64(sendOutput.seeker)}`
          );
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
            continue; // when network error, don't need to break, we can continue to send next message in the discussion.
          }
          // push the message id to the messageSent array. Do it here so that even if messageProtocol.sendMessage fails, the message will be considered as sent.
          messageSent.push(retryMessage.id!);
          console.log(
            `MessageService.resendMessages: message "${retryMessage.content}" has been sent successfully on the network`
          );
        }
      }
    }

    // Batch update statuses of all messages in messageSent to 'sent' in a Dexie transaction
    if (messageSent.length > 0) {
      await db.transaction('rw', db.messages, async () => {
        await Promise.all(
          messageSent.map(id =>
            db.messages.update(id, { status: MessageStatus.SENT })
          )
        );
      });
      console.log(
        `MessageService.resendMessages: all message that have been sent are updated on db as SENT`
      );
    }
  }
}

export const messageService = new MessageService(restMessageProtocol);
