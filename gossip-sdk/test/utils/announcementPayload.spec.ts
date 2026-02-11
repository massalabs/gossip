/**
 * Announcement payload encoding/decoding tests
 */

import { describe, it, expect } from 'vitest';
import {
  encodeAnnouncementPayload,
  decodeAnnouncementPayload,
} from '../../src/utils/announcementPayload';

describe('announcement payload', () => {
  it('returns undefined when both fields are empty', () => {
    expect(encodeAnnouncementPayload()).toBeUndefined();
    expect(encodeAnnouncementPayload('', '')).toBeUndefined();
    expect(encodeAnnouncementPayload('   ', '\n')).toBeUndefined();
  });

  it('round-trips username and message', () => {
    const encoded = encodeAnnouncementPayload('Alice', 'Hello there!');
    expect(encoded).toBeInstanceOf(Uint8Array);
    const decoded = decodeAnnouncementPayload(encoded);
    expect(decoded?.username).toBe('Alice');
    expect(decoded?.message).toBe('Hello there!');
  });

  it('round-trips username only', () => {
    const encoded = encodeAnnouncementPayload('AliceUser');
    const decoded = decodeAnnouncementPayload(encoded);
    expect(decoded?.username).toBe('AliceUser');
    expect(decoded?.message).toBeUndefined();
  });

  it('round-trips message only', () => {
    const encoded = encodeAnnouncementPayload(
      undefined,
      'Hello without username'
    );
    const decoded = decodeAnnouncementPayload(encoded);
    expect(decoded?.username).toBeUndefined();
    expect(decoded?.message).toBe('Hello without username');
  });

  it('round-trips special characters', () => {
    const encoded = encodeAnnouncementPayload(
      'Alice:Smith',
      'Hello: how are you?'
    );
    const decoded = decodeAnnouncementPayload(encoded);
    expect(decoded?.username).toBe('Alice:Smith');
    expect(decoded?.message).toBe('Hello: how are you?');
  });

  it('returns undefined fields for invalid payloads', () => {
    expect(decodeAnnouncementPayload(new Uint8Array(0))).toEqual({
      username: undefined,
      message: undefined,
    });
    expect(decodeAnnouncementPayload(new Uint8Array([0, 0, 0]))).toEqual({
      username: undefined,
      message: undefined,
    });

    const invalidLength = new Uint8Array([
      0,
      0,
      0,
      5, // username length = 5
      1,
      2,
      3, // only 3 bytes present
    ]);
    expect(decodeAnnouncementPayload(invalidLength)).toEqual({
      username: undefined,
      message: undefined,
    });
  });

  it('returns empty fields for random bytes', () => {
    const randomBytes = new Uint8Array([255, 0, 13, 37, 128, 64, 12, 7]);
    const decoded = decodeAnnouncementPayload(randomBytes);
    expect(decoded.username).toBeUndefined();
    expect(decoded.message).toBeUndefined();
  });
});
