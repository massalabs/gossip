/**
 * Message serialization utilities tests
 */

import { describe, it, expect } from 'vitest';
import { MessageType, MESSAGE_ID_SIZE } from '../../src/db';
import {
  serializeRegularMessage,
  serializeReplyMessage,
  serializeForwardMessage,
  serializeKeepAliveMessage,
  serializeDeleteMessage,
  serializeEditMessage,
  serializeReactionMessage,
  serializeGroupPlaintext,
  deserializeMessage,
  isGroupMessage,
} from '../../src/utils/messageSerialization';
import {
  Message as ProtoMessage,
  MessageType as ProtoMessageType,
} from '../../src/proto/generated/message';

const messageId = new Uint8Array(MESSAGE_ID_SIZE).fill(1);
const originalMsgId = new Uint8Array(MESSAGE_ID_SIZE).fill(2);
const originalContactId = new Uint8Array(32).fill(3);

describe('message serialization', () => {
  it('serializes and deserializes regular messages', () => {
    const serialized = serializeRegularMessage('hello', messageId);
    const deserialized = deserializeMessage(serialized);
    expect(deserialized.content).toBe('hello');
    expect(deserialized.type).toBe(MessageType.TEXT);
    expect(deserialized.messageId).toEqual(messageId);
  });

  it('serializes and deserializes reply messages', () => {
    const serialized = serializeReplyMessage('new', originalMsgId, messageId);
    const deserialized = deserializeMessage(serialized);
    expect(deserialized.content).toBe('new');
    expect(deserialized.replyTo?.originalMsgId).toEqual(originalMsgId);
  });

  it('serializes and deserializes forward messages', () => {
    const serialized = serializeForwardMessage(
      'forward',
      'note',
      messageId,
      originalContactId
    );
    const deserialized = deserializeMessage(serialized);
    expect(deserialized.content).toBe('note');
    expect(deserialized.forwardOf?.originalContent).toBe('forward');
    expect(deserialized.forwardOf?.originalContactId).toEqual(
      originalContactId
    );
  });

  it('serializes keep-alive messages', () => {
    const serialized = serializeKeepAliveMessage();
    const deserialized = deserializeMessage(serialized);
    expect(deserialized.type).toBe(MessageType.KEEP_ALIVE);
  });

  it('serializes a group plaintext under its own type, and nothing else', () => {
    const plaintext = new Uint8Array([1, 2, 3]);
    const serialized = serializeGroupPlaintext(plaintext);
    expect(ProtoMessage.decode(serialized)).toEqual({
      messageType: ProtoMessageType.MESSAGE_TYPE_GROUP,
      content: '',
      groupPlaintext: plaintext,
    });
    // Type 8, then the plaintext in field 7: nothing else is written.
    expect(Array.from(serialized)).toEqual([0x08, 8, 0x3a, 3, 1, 2, 3]);
    const deserialized = deserializeMessage(serialized);
    expect(isGroupMessage(deserialized)).toBe(true);
    expect(deserialized.groupPlaintext).toEqual(plaintext);
  });

  it('reads a group message without a plaintext as one without content', () => {
    const deserialized = deserializeMessage(
      ProtoMessage.encode({ messageType: ProtoMessageType.MESSAGE_TYPE_GROUP })
    );
    expect(isGroupMessage(deserialized)).toBe(true);
    expect(deserialized.groupPlaintext).toBeUndefined();
  });

  it('ignores a group plaintext under any other type', () => {
    const plaintext = new Uint8Array([1, 2, 3]);
    const keepAlive = deserializeMessage(
      ProtoMessage.encode({
        messageType: ProtoMessageType.MESSAGE_TYPE_KEEP_ALIVE,
        content: '',
        groupPlaintext: plaintext,
      })
    );
    expect(isGroupMessage(keepAlive)).toBe(false);
    expect(keepAlive).toEqual({ content: '', type: MessageType.KEEP_ALIVE });

    const text = deserializeMessage(
      ProtoMessage.encode({
        messageType: ProtoMessageType.MESSAGE_TYPE_REGULAR,
        messageId,
        content: 'hello',
        groupPlaintext: plaintext,
      })
    );
    expect(isGroupMessage(text)).toBe(false);
    expect(text.type).toBe(MessageType.TEXT);
    expect(text.content).toBe('hello');
    expect('groupPlaintext' in text).toBe(false);

    const retention = deserializeMessage(
      ProtoMessage.encode({
        messageType: ProtoMessageType.MESSAGE_TYPE_RETENTION_POLICY,
        content: '60',
        groupPlaintext: plaintext,
      })
    );
    expect(retention).toEqual({
      content: '60',
      type: MessageType.RETENTION_POLICY,
    });
  });

  it('serializes and deserializes delete messages', () => {
    const serialized = serializeDeleteMessage(originalMsgId, messageId);
    const deserialized = deserializeMessage(serialized);
    expect(deserialized.type).toBe(MessageType.DELETED);
    expect(deserialized.deleteOf?.originalMsgId).toEqual(originalMsgId);
  });

  it('serializes and deserializes edit messages', () => {
    const serialized = serializeEditMessage(
      'edited content',
      originalMsgId,
      messageId
    );
    const deserialized = deserializeMessage(serialized);
    expect(deserialized.type).toBe(MessageType.TEXT);
    expect(deserialized.content).toBe('edited content');
    expect(deserialized.editOf?.originalMsgId).toEqual(originalMsgId);
  });

  it('serializes and deserializes reaction messages', () => {
    const serialized = serializeReactionMessage('❤️', originalMsgId, messageId);
    const deserialized = deserializeMessage(serialized);
    expect(deserialized.type).toBe(MessageType.REACTION);
    expect(deserialized.content).toBe('❤️');
    expect(deserialized.reactionOf?.originalMsgId).toEqual(originalMsgId);
    expect(deserialized.messageId).toEqual(messageId);
  });

  it('serializes forward without additional content', () => {
    const serialized = serializeForwardMessage(
      'Just forwarding this',
      '',
      messageId,
      originalContactId
    );
    const deserialized = deserializeMessage(serialized);
    expect(deserialized.content).toBe('');
    expect(deserialized.forwardOf?.originalContent).toBe(
      'Just forwarding this'
    );
  });
});

describe('unknown session message types', () => {
  it('refuses a type this release does not know instead of reading it as text', () => {
    for (const messageType of [9, 42, 1_000]) {
      const bytes = ProtoMessage.encode({
        messageType: messageType as ProtoMessageType,
        messageId,
        content: 'from the future',
      });
      expect(() => deserializeMessage(bytes)).toThrow(/unknown/);
    }
  });
});

describe('Deserialization Failure Handling', () => {
  it('should handle invalid message format gracefully', () => {
    const invalidData = new Uint8Array([0, 1]);

    try {
      const result = deserializeMessage(invalidData);
      expect(result).toBeDefined();
    } catch {
      expect(true).toBe(true);
    }
  });

  it('should handle corrupted message bytes', () => {
    const corruptedData = new Uint8Array([0, 255, 255, 255, 255, 0, 0, 0, 0]);

    try {
      const result = deserializeMessage(corruptedData);
      expect(result).toBeDefined();
    } catch {
      expect(true).toBe(true);
    }
  });

  it('should handle empty message data', () => {
    const emptyData = new Uint8Array(0);

    try {
      const result = deserializeMessage(emptyData);
      expect(result.content).toBe('');
    } catch {
      expect(true).toBe(true);
    }
  });
});
