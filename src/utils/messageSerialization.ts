/**
 * Message Serialization Utilities
 *
 * Functions for serializing and deserializing messages for the protocol.
 * Supports regular text messages, replies, forwards, and keep-alive messages.
 */

import { strToBytes, bytesToStr, U32 } from '@massalabs/massa-web3';
import { MessageType } from '../db';

// Message type constants (protocol-level)
const MESSAGE_TYPE_REGULAR = 0x00;
const MESSAGE_TYPE_REPLY = 0x01;
const MESSAGE_TYPE_FORWARD = 0x02;
export const MESSAGE_TYPE_KEEP_ALIVE = 0x03;

// Seeker size: 1 byte length prefix + 32 bytes hash + 1 byte key index
const SEEKER_SIZE = 34;

export interface DeserializedMessage {
  content: string;
  replyTo?: {
    originalContent: string;
    originalSeeker: Uint8Array;
  };
  forwardOf?: {
    originalContent: string;
    originalSeeker: Uint8Array;
  };
  type: MessageType;
}

/**
 * Serialize a keep-alive message
 * Keep-alive messages are used to maintain session activity
 */
export function serializeKeepAliveMessage(): Uint8Array {
  return new Uint8Array([MESSAGE_TYPE_KEEP_ALIVE]);
}

/**
 * Serialize a regular text message
 *
 * Format: [type: 1 byte][content: variable]
 *
 * @param content - The message content string
 * @returns Serialized message bytes
 */
export function serializeRegularMessage(content: string): Uint8Array {
  const contentBytes = strToBytes(content);
  const result = new Uint8Array(1 + contentBytes.length);
  result[0] = MESSAGE_TYPE_REGULAR;
  result.set(contentBytes, 1);
  return result;
}

/**
 * Serialize a reply message
 *
 * Format: [type: 1 byte][originalContentLen: 4 bytes][originalContent][seeker: 34 bytes][newContent]
 *
 * @param newContent - The reply content
 * @param originalContent - The content being replied to
 * @param originalSeeker - The seeker of the original message
 * @returns Serialized reply message bytes
 */
export function serializeReplyMessage(
  newContent: string,
  originalContent: string,
  originalSeeker: Uint8Array
): Uint8Array {
  const newContentBytes = strToBytes(newContent);
  const originalContentBytes = strToBytes(originalContent);
  const originalContentLenBytes = U32.toBytes(
    BigInt(originalContentBytes.length)
  );

  // Calculate total size
  const totalSize =
    1 + // type
    originalContentLenBytes.length + // length prefix (4 bytes)
    originalContentBytes.length + // original content
    SEEKER_SIZE + // seeker
    newContentBytes.length; // new content

  const result = new Uint8Array(totalSize);
  let offset = 0;

  // Type byte
  result[offset++] = MESSAGE_TYPE_REPLY;

  // Original content length (4 bytes)
  result.set(originalContentLenBytes, offset);
  offset += originalContentLenBytes.length;

  // Original content
  result.set(originalContentBytes, offset);
  offset += originalContentBytes.length;

  // Seeker (34 bytes)
  result.set(originalSeeker, offset);
  offset += SEEKER_SIZE;

  // New content
  result.set(newContentBytes, offset);

  return result;
}

/**
 * Serialize a forward message
 *
 * Format: [type: 1 byte][forwardContentLen: 4 bytes][forwardContent][seeker: 34 bytes][newContent]
 *
 * @param forwardContent - The content being forwarded
 * @param newContent - Optional new content to add (empty string if none)
 * @param originalSeeker - The seeker of the original message
 * @returns Serialized forward message bytes
 */
export function serializeForwardMessage(
  forwardContent: string,
  newContent: string,
  originalSeeker: Uint8Array
): Uint8Array {
  const newContentBytes = strToBytes(newContent);
  const forwardContentBytes = strToBytes(forwardContent);
  const forwardContentLenBytes = U32.toBytes(
    BigInt(forwardContentBytes.length)
  );

  // Calculate total size
  const totalSize =
    1 + // type
    forwardContentLenBytes.length + // length prefix (4 bytes)
    forwardContentBytes.length + // forward content
    SEEKER_SIZE + // seeker
    newContentBytes.length; // new content

  const result = new Uint8Array(totalSize);
  let offset = 0;

  // Type byte
  result[offset++] = MESSAGE_TYPE_FORWARD;

  // Forward content length (4 bytes)
  result.set(forwardContentLenBytes, offset);
  offset += forwardContentLenBytes.length;

  // Forward content
  result.set(forwardContentBytes, offset);
  offset += forwardContentBytes.length;

  // Seeker (34 bytes)
  result.set(originalSeeker, offset);
  offset += SEEKER_SIZE;

  // New content
  result.set(newContentBytes, offset);

  return result;
}

/**
 * Deserialize a message from bytes
 *
 * @param buffer - The serialized message bytes
 * @returns Deserialized message object
 * @throws Error if message format is invalid
 */
export function deserializeMessage(buffer: Uint8Array): DeserializedMessage {
  if (buffer.length < 1) {
    throw new Error('Empty message buffer');
  }

  const messageType = buffer[0];

  switch (messageType) {
    case MESSAGE_TYPE_KEEP_ALIVE:
      return {
        content: '',
        type: MessageType.KEEP_ALIVE,
      };

    case MESSAGE_TYPE_REGULAR:
      return {
        content: bytesToStr(buffer.slice(1)),
        type: MessageType.TEXT,
      };

    case MESSAGE_TYPE_REPLY: {
      // Format: [type: 1][originalContentLen: 4][originalContent][seeker: 34][newContent]
      let offset = 1;

      // Read original content length (4 bytes)
      const originalContentLen = Number(
        U32.fromBytes(buffer.slice(offset, offset + 4))
      );
      offset += 4;

      // Read original content
      const originalContent = bytesToStr(
        buffer.slice(offset, offset + originalContentLen)
      );
      offset += originalContentLen;

      // Read seeker (34 bytes)
      const originalSeeker = buffer.slice(offset, offset + SEEKER_SIZE);
      offset += SEEKER_SIZE;

      // Read new content
      const newContent = bytesToStr(buffer.slice(offset));

      return {
        content: newContent,
        replyTo: {
          originalContent,
          originalSeeker,
        },
        type: MessageType.TEXT,
      };
    }

    case MESSAGE_TYPE_FORWARD: {
      // Format: [type: 1][forwardContentLen: 4][forwardContent][seeker: 34][newContent]
      let offset = 1;

      // Read forward content length (4 bytes)
      const forwardContentLen = Number(
        U32.fromBytes(buffer.slice(offset, offset + 4))
      );
      offset += 4;

      // Read forward content
      const forwardContent = bytesToStr(
        buffer.slice(offset, offset + forwardContentLen)
      );
      offset += forwardContentLen;

      // Read seeker (34 bytes)
      const originalSeeker = buffer.slice(offset, offset + SEEKER_SIZE);
      offset += SEEKER_SIZE;

      // Read new content
      const newContent = bytesToStr(buffer.slice(offset));

      return {
        content: newContent,
        forwardOf: {
          originalContent: forwardContent,
          originalSeeker,
        },
        type: MessageType.TEXT,
      };
    }

    default:
      throw new Error(`Unknown message type: ${messageType}`);
  }
}
