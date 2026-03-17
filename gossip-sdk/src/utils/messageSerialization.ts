/**
 * Message Serialization Utilities
 *
 * Functions for serializing and deserializing messages for the protocol.
 * Supports regular text messages, replies, forwards, and keep-alive messages.
 */

import { MessageType, MESSAGE_ID_SIZE } from '../db/index.js';
import {
  Message as ProtoMessage,
  MessageType as ProtoMessageType,
} from '../proto/generated/message.js';

export const MESSAGE_TYPE_KEEP_ALIVE = ProtoMessageType.MESSAGE_TYPE_KEEP_ALIVE;
export const MESSAGE_TYPE_DELETE = ProtoMessageType.MESSAGE_TYPE_DELETE;
export const MESSAGE_TYPE_EDIT = ProtoMessageType.MESSAGE_TYPE_EDIT;

export interface DeserializedMessage {
  content: string;
  messageId?: Uint8Array;
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
  type: MessageType;
}

/**
 * Serialize a keep-alive message
 * Keep-alive messages are used to maintain session activity
 */
export function serializeKeepAliveMessage(): Uint8Array {
  return ProtoMessage.encode({
    messageType: ProtoMessageType.MESSAGE_TYPE_KEEP_ALIVE,
    content: '',
  });
}

/**
 * Serialize a regular text message
 *
 * Format: [type: 1 byte][messageId: 12 bytes][content: variable]
 *
 * @param content - The message content string
 * @param messageId - 12-byte random message ID
 * @returns Serialized message bytes
 */
export function serializeRegularMessage(
  content: string,
  messageId: Uint8Array
): Uint8Array {
  if (messageId.length !== MESSAGE_ID_SIZE) {
    throw new Error(`messageId must be ${MESSAGE_ID_SIZE} bytes`);
  }
  return ProtoMessage.encode({
    messageType: ProtoMessageType.MESSAGE_TYPE_REGULAR,
    messageId,
    content,
  });
}

/**
 * Serialize a reply message
 *
 * Format: protobuf Message with citedMsgId set
 *
 * @param newContent - The reply content
 * @param originalMsgId - The messageId of the message being replied to
 * @param messageId - 12-byte random message ID
 * @returns Serialized reply message bytes
 */
export function serializeReplyMessage(
  newContent: string,
  originalMsgId: Uint8Array,
  messageId: Uint8Array
): Uint8Array {
  if (messageId.length !== MESSAGE_ID_SIZE) {
    throw new Error(`messageId must be ${MESSAGE_ID_SIZE} bytes`);
  }
  if (originalMsgId.length !== MESSAGE_ID_SIZE) {
    throw new Error(`originalMsgId must be ${MESSAGE_ID_SIZE} bytes`);
  }
  return ProtoMessage.encode({
    messageType: ProtoMessageType.MESSAGE_TYPE_REPLY,
    messageId,
    content: newContent,
    citedMsgId: originalMsgId,
  });
}

/**
 * Serialize a forward message
 *
 * Format: protobuf Message with citedContactId set
 *
 * @param forwardedContent - The content being forwarded
 * @param newContent - Optional new content to add (empty string if none)
 * @param originalContactId - The contact ID (32 bytes) of the original message
 * @param messageId - 12-byte random message ID
 * @returns Serialized forward message bytes
 */
export function serializeForwardMessage(
  forwardedContent: string,
  newContent: string,
  messageId: Uint8Array,
  originalContactId?: Uint8Array
): Uint8Array {
  if (messageId.length !== MESSAGE_ID_SIZE) {
    throw new Error(`messageId must be ${MESSAGE_ID_SIZE} bytes`);
  }
  if (originalContactId && originalContactId.length !== 32) {
    throw new Error('originalContactId must be 32 bytes');
  }
  return ProtoMessage.encode({
    messageType: ProtoMessageType.MESSAGE_TYPE_FORWARD,
    messageId,
    content: newContent,
    citedContactId: originalContactId,
    forwardedContent,
  });
}

/**
 * Serialize a delete control message
 *
 * Format: protobuf Message with citedMsgId set and delete type
 *
 * @param originalMsgId - The messageId of the message being deleted
 * @param messageId - 12-byte random message ID for the control message
 * @returns Serialized delete message bytes
 */
export function serializeDeleteMessage(
  originalMsgId: Uint8Array,
  messageId: Uint8Array
): Uint8Array {
  if (messageId.length !== MESSAGE_ID_SIZE) {
    throw new Error(`messageId must be ${MESSAGE_ID_SIZE} bytes`);
  }
  if (originalMsgId.length !== MESSAGE_ID_SIZE) {
    throw new Error(`originalMsgId must be ${MESSAGE_ID_SIZE} bytes`);
  }
  return ProtoMessage.encode({
    messageType: ProtoMessageType.MESSAGE_TYPE_DELETE,
    messageId,
    content: '',
    citedMsgId: originalMsgId,
  });
}

/**
 * Serialize an edit control message
 *
 * Format: protobuf Message with citedMsgId set to the original messageId and
 * content carrying the new text.
 *
 * @param newContent - The updated message content
 * @param originalMsgId - The messageId of the message being edited
 * @param messageId - 12-byte random message ID for the control message
 * @returns Serialized edit message bytes
 */
export function serializeEditMessage(
  newContent: string,
  originalMsgId: Uint8Array,
  messageId: Uint8Array
): Uint8Array {
  if (messageId.length !== MESSAGE_ID_SIZE) {
    throw new Error(`messageId must be ${MESSAGE_ID_SIZE} bytes`);
  }
  if (originalMsgId.length !== MESSAGE_ID_SIZE) {
    throw new Error(`originalMsgId must be ${MESSAGE_ID_SIZE} bytes`);
  }
  return ProtoMessage.encode({
    messageType: ProtoMessageType.MESSAGE_TYPE_EDIT,
    messageId,
    content: newContent,
    citedMsgId: originalMsgId,
  });
}

export function serializeReactionMessage(
  emoji: string,
  originalMsgId: Uint8Array,
  messageId: Uint8Array
): Uint8Array {
  if (messageId.length !== MESSAGE_ID_SIZE) {
    throw new Error(`messageId must be ${MESSAGE_ID_SIZE} bytes`);
  }
  if (originalMsgId.length !== MESSAGE_ID_SIZE) {
    throw new Error(`originalMsgId must be ${MESSAGE_ID_SIZE} bytes`);
  }
  return ProtoMessage.encode({
    messageType: ProtoMessageType.MESSAGE_TYPE_REACTION,
    messageId,
    content: emoji,
    citedMsgId: originalMsgId,
  });
}

/**
 * Deserialize a message from bytes
 *
 * @param buffer - The serialized message bytes
 * @returns Deserialized message object
 * @throws Error if message format is invalid
 */
export function deserializeMessage(buffer: Uint8Array): DeserializedMessage {
  if (buffer.length === 0) {
    throw new Error('Empty message buffer');
  }

  const decoded = ProtoMessage.decode(buffer);
  const protoType =
    decoded.messageType ?? ProtoMessageType.MESSAGE_TYPE_REGULAR;

  if (protoType === ProtoMessageType.MESSAGE_TYPE_KEEP_ALIVE) {
    return {
      content: '',
      type: MessageType.KEEP_ALIVE,
    };
  }

  const content = decoded.content ?? '';
  const messageId = decoded.messageId;
  const citedMsgId = decoded.citedMsgId;

  let replyTo = undefined;
  let deleteOf = undefined;
  let editOf = undefined;
  let reactionOf = undefined;

  if (protoType === ProtoMessageType.MESSAGE_TYPE_REPLY) {
    if (citedMsgId && citedMsgId.length === MESSAGE_ID_SIZE) {
      replyTo = {
        originalMsgId: citedMsgId,
      };
    } else {
      throw new Error(
        `invalid message format: message of type reply but citedMsgId empty or not correct size (${MESSAGE_ID_SIZE})`
      );
    }
  }

  if (protoType === ProtoMessageType.MESSAGE_TYPE_DELETE) {
    if (citedMsgId && citedMsgId.length === MESSAGE_ID_SIZE) {
      deleteOf = {
        originalMsgId: citedMsgId,
      };
    } else {
      throw new Error(
        `invalid message format: message of type delete but citedMsgId empty or not correct size (${MESSAGE_ID_SIZE})`
      );
    }
  }

  if (protoType === ProtoMessageType.MESSAGE_TYPE_EDIT) {
    if (citedMsgId && citedMsgId.length === MESSAGE_ID_SIZE) {
      editOf = {
        originalMsgId: citedMsgId,
      };
    } else {
      throw new Error(
        `invalid message format: message of type edit but citedMsgId empty or not correct size (${MESSAGE_ID_SIZE})`
      );
    }
  }

  if (protoType === ProtoMessageType.MESSAGE_TYPE_REACTION) {
    if (citedMsgId && citedMsgId.length === MESSAGE_ID_SIZE) {
      reactionOf = {
        originalMsgId: citedMsgId,
      };
    } else {
      throw new Error(
        `invalid message format: message of type reaction but citedMsgId empty or not correct size (${MESSAGE_ID_SIZE})`
      );
    }
  }

  let forwardOf = undefined;
  if (protoType === ProtoMessageType.MESSAGE_TYPE_FORWARD) {
    if (
      decoded.forwardedContent &&
      decoded.citedContactId &&
      decoded.citedContactId.length === 32
    ) {
      forwardOf = {
        originalContent: decoded.forwardedContent,
        originalContactId: decoded.citedContactId,
      };
    } else {
      throw new Error(
        `invalid message format: message of type forward but forwardedContent empty or not correct size (${MESSAGE_ID_SIZE}) or citedContactId empty or not correct size (32)`
      );
    }
  }

  return {
    content,
    messageId,
    replyTo,
    forwardOf,
    deleteOf,
    editOf,
    reactionOf,
    type:
      protoType === ProtoMessageType.MESSAGE_TYPE_DELETE
        ? MessageType.DELETED
        : protoType === ProtoMessageType.MESSAGE_TYPE_REACTION
          ? MessageType.REACTION
          : MessageType.TEXT,
  };
}
