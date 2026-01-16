/**
 * Message serialization tests
 */

import { describe, it, expect } from 'vitest';
import {
  serializeRegularMessage,
  serializeReplyMessage,
  serializeForwardMessage,
  serializeKeepAliveMessage,
  deserializeMessage,
  MESSAGE_TYPE_KEEP_ALIVE,
} from '../src/utils/messageSerialization';
import { MessageType } from '../src/db';

const seeker = new Uint8Array(34).fill(4);

describe('message serialization', () => {
  it('serializes and deserializes regular messages', () => {
    const serialized = serializeRegularMessage('hello');
    const deserialized = deserializeMessage(serialized);
    expect(deserialized.content).toBe('hello');
    expect(deserialized.type).toBe(MessageType.TEXT);
  });

  it('serializes and deserializes reply messages', () => {
    const serialized = serializeReplyMessage('new', 'old', seeker);
    const deserialized = deserializeMessage(serialized);
    expect(deserialized.content).toBe('new');
    expect(deserialized.replyTo?.originalContent).toBe('old');
    expect(deserialized.replyTo?.originalSeeker).toEqual(seeker);
  });

  it('serializes and deserializes forward messages', () => {
    const serialized = serializeForwardMessage('forward', 'note', seeker);
    const deserialized = deserializeMessage(serialized);
    expect(deserialized.content).toBe('note');
    expect(deserialized.forwardOf?.originalContent).toBe('forward');
    expect(deserialized.forwardOf?.originalSeeker).toEqual(seeker);
  });

  it('serializes keep-alive messages', () => {
    const serialized = serializeKeepAliveMessage();
    expect(serialized[0]).toBe(MESSAGE_TYPE_KEEP_ALIVE);
    const deserialized = deserializeMessage(serialized);
    expect(deserialized.type).toBe(MessageType.KEEP_ALIVE);
  });
});
