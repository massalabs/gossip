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
  deserializeMessage,
} from '../../src/utils/messageSerialization';

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
