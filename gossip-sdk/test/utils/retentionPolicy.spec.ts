/**
 * Retention policy serialization tests
 */

import { describe, it, expect } from 'vitest';
import { MessageType } from '../../src/db';
import {
  serializeRetentionPolicyMessage,
  deserializeMessage,
} from '../../src/utils/messageSerialization';

describe('retention policy serialization', () => {
  it('serializes and deserializes a retention policy message with a duration', () => {
    const serialized = serializeRetentionPolicyMessage(86400);
    const deserialized = deserializeMessage(serialized);

    expect(deserialized.type).toBe(MessageType.RETENTION_POLICY);
    expect(deserialized.content).toBe('86400');
  });

  it('serializes and deserializes a retention policy with duration 0 (disable)', () => {
    const serialized = serializeRetentionPolicyMessage(0);
    const deserialized = deserializeMessage(serialized);

    expect(deserialized.type).toBe(MessageType.RETENTION_POLICY);
    expect(deserialized.content).toBe('0');
  });

  it.each([3600, 28800, 86400, 604800, 2592000])(
    'round-trips all preset durations (%i seconds)',
    duration => {
      const serialized = serializeRetentionPolicyMessage(duration);
      const deserialized = deserializeMessage(serialized);

      expect(deserialized.type).toBe(MessageType.RETENTION_POLICY);
      expect(deserialized.content).toBe(String(duration));
    }
  );
});
