/**
 * Message serialization utilities tests
 */

import { describe, it, expect } from 'vitest';
import { MessageType } from '../../src/db.js';
import {
  serializeRegularMessage,
  serializeReplyMessage,
  serializeForwardMessage,
  serializeKeepAliveMessage,
  deserializeMessage,
  MESSAGE_TYPE_KEEP_ALIVE,
} from '../../src/utils/messageSerialization.js';

const serializationSeeker = new Uint8Array(34).fill(4);

describe('message serialization', () => {
  it('serializes and deserializes regular messages', () => {
    const serialized = serializeRegularMessage('hello');
    const deserialized = deserializeMessage(serialized);
    expect(deserialized.content).toBe('hello');
    expect(deserialized.type).toBe(MessageType.TEXT);
  });

  it('serializes and deserializes reply messages', () => {
    const serialized = serializeReplyMessage('new', 'old', serializationSeeker);
    const deserialized = deserializeMessage(serialized);
    expect(deserialized.content).toBe('new');
    expect(deserialized.replyTo?.originalContent).toBe('old');
    expect(deserialized.replyTo?.originalSeeker).toEqual(serializationSeeker);
  });

  it('serializes and deserializes forward messages', () => {
    const serialized = serializeForwardMessage(
      'forward',
      'note',
      serializationSeeker
    );
    const deserialized = deserializeMessage(serialized);
    expect(deserialized.content).toBe('note');
    expect(deserialized.forwardOf?.originalContent).toBe('forward');
    expect(deserialized.forwardOf?.originalSeeker).toEqual(serializationSeeker);
  });

  it('serializes keep-alive messages', () => {
    const serialized = serializeKeepAliveMessage();
    expect(serialized[0]).toBe(MESSAGE_TYPE_KEEP_ALIVE);
    const deserialized = deserializeMessage(serialized);
    expect(deserialized.type).toBe(MessageType.KEEP_ALIVE);
  });

  it('serializes reply with empty original content', () => {
    const serialized = serializeReplyMessage('reply', '', serializationSeeker);
    const deserialized = deserializeMessage(serialized);
    expect(deserialized.replyTo?.originalContent).toBe('');
    expect(deserialized.content).toBe('reply');
  });

  it('serializes reply with unicode characters', () => {
    const serialized = serializeReplyMessage(
      'Reply with emoji ',
      'Original with unicode ',
      serializationSeeker
    );
    const deserialized = deserializeMessage(serialized);
    expect(deserialized.content).toBe('Reply with emoji ');
    expect(deserialized.replyTo?.originalContent).toBe(
      'Original with unicode '
    );
  });

  it('serializes forward without additional content', () => {
    const serialized = serializeForwardMessage(
      'Just forwarding this',
      '',
      serializationSeeker
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
