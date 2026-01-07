import { strToBytes, bytesToStr, U32 } from '@massalabs/massa-web3';
import { MessageType } from '../db';

// Seeker format: [hash_length: 1 byte][hash_bytes: 32 bytes][key: 1 byte]
// Seeker is always 34 bytes: 1 + 32 + 1
const SEEKER_SIZE = 34;
// Message type tags
const MESSAGE_TYPE_REGULAR = 0x00;
const MESSAGE_TYPE_REPLY = 0x01;
const MESSAGE_TYPE_FORWARD = 0x02;
export const MESSAGE_TYPE_KEEP_ALIVE = 0x03;

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
 * Format: [type: 1 byte]
 */
export function serializeKeepAliveMessage(): Uint8Array {
  return new Uint8Array([MESSAGE_TYPE_KEEP_ALIVE]);
}

/**
 * Serialize a regular message
 * Format: [type: 1 byte][content_bytes]
 */
export function serializeRegularMessage(content: string): Uint8Array {
  if (!content || content.trim().length === 0) {
    throw new Error('Message content cannot be empty');
  }
  const contentBytes = strToBytes(content);
  return new Uint8Array([MESSAGE_TYPE_REGULAR, ...contentBytes]);
}

/**
 * Serialize a reply message with the original message content and seeker
 * Format: [type: 1 byte][seeker][new_content_length: 4 bytes][new_content][original_content_length: 4 bytes][original_content]
 * Note: Seeker already contains its length as the first byte, so we don't store it separately
 */
export function serializeReplyMessage(
  newContent: string,
  originalContent: string,
  originalSeeker: Uint8Array
): Uint8Array {
  if (!newContent || newContent.trim().length === 0) {
    throw new Error('Message content cannot be empty');
  }
  if (!originalContent || originalContent.trim().length === 0) {
    throw new Error('Original message content cannot be empty');
  }
  if (originalSeeker.length !== SEEKER_SIZE) {
    throw new Error(
      `Invalid seeker size: expected ${SEEKER_SIZE} bytes, got ${originalSeeker.length}`
    );
  }

  const newContentBytes = strToBytes(newContent);
  const originalContentBytes = strToBytes(originalContent);

  const newLengthBytes = U32.toBytes(BigInt(newContentBytes.length));
  const origLengthBytes = U32.toBytes(BigInt(originalContentBytes.length));

  return new Uint8Array([
    MESSAGE_TYPE_REPLY,
    ...originalSeeker,
    ...newLengthBytes,
    ...newContentBytes,
    ...origLengthBytes,
    ...originalContentBytes,
  ]);
}

/**
 * Serialize a forward message with the original forwarded content and new content.
 * Format: [type: 1 byte][seeker][forward_content_length: 4 bytes][forward_content][new_content_length: 4 bytes][new_content]
 */
export function serializeForwardMessage(
  forwardContent: string,
  newContent: string,
  originalSeeker: Uint8Array
): Uint8Array {
  if (!forwardContent || forwardContent.trim().length === 0) {
    throw new Error('Forwarded content cannot be empty');
  }
  if (originalSeeker.length !== SEEKER_SIZE) {
    throw new Error(
      `Invalid seeker size: expected ${SEEKER_SIZE} bytes, got ${originalSeeker.length}`
    );
  }

  const forwardBytes = strToBytes(forwardContent);
  const newContentBytes = strToBytes(newContent);

  const forwardLengthBytes = U32.toBytes(BigInt(forwardBytes.length));
  const newLengthBytes = U32.toBytes(BigInt(newContentBytes.length));

  return new Uint8Array([
    MESSAGE_TYPE_FORWARD,
    ...originalSeeker,
    ...forwardLengthBytes,
    ...forwardBytes,
    ...newLengthBytes,
    ...newContentBytes,
  ]);
}

/**
 * Deserialize a message buffer
 * Returns the content and optional reply/forward information
 */
export function deserializeMessage(buffer: Uint8Array): DeserializedMessage {
  if (buffer.length === 0) {
    throw new Error('Empty message buffer');
  }

  const messageType = buffer[0];

  /* REGULAR MESSAGE */
  if (messageType === MESSAGE_TYPE_REGULAR) {
    // Regular message: [0x00][content]
    const contentBytes = buffer.slice(1);
    const content = bytesToStr(contentBytes);
    return { content, type: MessageType.TEXT };

    /* REPLY MESSAGE */
  } else if (messageType === MESSAGE_TYPE_REPLY) {
    // Reply message format: [0x01][seeker][new_len: 4][new][orig_len: 4][orig]
    if (buffer.length < 1 + SEEKER_SIZE + 4 + 4) {
      throw new Error('Invalid reply message format: too short');
    }

    let offset = 1;

    // Read seeker (always 34 bytes)
    const originalSeeker = buffer.slice(offset, offset + SEEKER_SIZE);

    // Validate seeker structure: first byte should be 32 (hash length)
    if (originalSeeker[0] !== 32) {
      throw new Error('Invalid reply message format: invalid seeker structure');
    }
    offset += SEEKER_SIZE;

    // Read new content length
    const newContentLength = Number(
      U32.fromBytes(buffer.slice(offset, offset + 4))
    );
    if (buffer.length < offset + 4 + newContentLength + 4) {
      throw new Error('Invalid reply message format: new content incomplete');
    }

    // Read new content
    offset += 4;
    const newContentStart = offset;
    const newContentEnd = newContentStart + newContentLength;
    const newContentBytes = buffer.slice(newContentStart, newContentEnd);
    const newContent = bytesToStr(newContentBytes);

    // Read original content length
    const originalContentLength = Number(
      U32.fromBytes(buffer.slice(newContentEnd, newContentEnd + 4))
    );
    if (buffer.length < newContentEnd + 4 + originalContentLength) {
      throw new Error(
        'Invalid reply message format: original content incomplete'
      );
    }

    // Read original content
    const originalContentStart = newContentEnd + 4;
    const originalContentBytes = buffer.slice(
      originalContentStart,
      originalContentStart + originalContentLength
    );
    const originalContent = bytesToStr(originalContentBytes);

    return {
      content: newContent,
      replyTo: {
        originalContent,
        originalSeeker,
      },
      type: MessageType.TEXT,
    };

    /* FORWARD MESSAGE */
  } else if (messageType === MESSAGE_TYPE_FORWARD) {
    // Forward message format: [0x02][seeker][forward_len: 4][forward][new_len: 4][new]
    if (buffer.length < 1 + SEEKER_SIZE + 4 + 4) {
      throw new Error('Invalid forward message format: too short');
    }

    let offset = 1;

    // Read seeker (always 34 bytes)
    const originalSeeker = buffer.slice(offset, offset + SEEKER_SIZE);

    // Validate seeker structure: first byte should be 32 (hash length)
    if (originalSeeker[0] !== 32) {
      throw new Error(
        'Invalid forward message format: invalid seeker structure'
      );
    }
    offset += SEEKER_SIZE;

    // Read forward content length
    const forwardLength = Number(
      U32.fromBytes(buffer.slice(offset, offset + 4))
    );

    if (buffer.length < offset + 4 + forwardLength + 4) {
      throw new Error(
        'Invalid forward message format: forward content incomplete'
      );
    }

    offset += 4;
    const forwardStart = offset;
    const forwardEnd = forwardStart + forwardLength;
    const forwardBytes = buffer.slice(forwardStart, forwardEnd);
    const forwardContent = bytesToStr(forwardBytes);

    // Read new content length
    const newContentLength = Number(
      U32.fromBytes(buffer.slice(forwardEnd, forwardEnd + 4))
    );

    if (buffer.length < forwardEnd + 4 + newContentLength) {
      throw new Error('Invalid forward message format: new content incomplete');
    }

    const newContentStart = forwardEnd + 4;
    const newContentEnd = newContentStart + newContentLength;
    const newContentBytes = buffer.slice(newContentStart, newContentEnd);
    const newContent = bytesToStr(newContentBytes);

    return {
      content: newContent,
      forwardOf: {
        originalContent: forwardContent,
        originalSeeker,
      },
      type: MessageType.TEXT,
    };

    /* KEEP ALIVE MESSAGE */
  } else if (messageType === MESSAGE_TYPE_KEEP_ALIVE) {
    return {
      content: '',
      type: MessageType.KEEP_ALIVE,
    };
  } else {
    throw new Error(`Unknown message type: ${messageType}`);
  }
}
