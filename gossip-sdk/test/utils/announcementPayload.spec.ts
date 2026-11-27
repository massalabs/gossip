/**
 * Announcement payload encoding/decoding tests
 */

import { describe, it, expect } from 'vitest';
import { Args } from '@massalabs/massa-web3';
import {
  encodeAnnouncementPayload,
  encodeContactRequestPayload,
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

  it('reads a contact request of 0.1.0 or 0.1.1 that states a timer: the timer is ignored', () => {
    // The third field those versions sent: the timer of the chat the
    // request asked for, as a decimal string.
    const older = new Args()
      .addString('Alice')
      .addString('hi')
      .addString('3600000')
      .serialize();
    expect(decodeAnnouncementPayload(older)).toEqual({
      username: 'Alice',
      message: 'hi',
    });
    const onlyTimer = new Args()
      .addString('')
      .addString('')
      .addString('0')
      .serialize();
    expect(decodeAnnouncementPayload(onlyTimer)).toEqual({
      username: undefined,
      message: undefined,
    });
  });

  it('encodes no timer: a name and a message only', () => {
    const encoded = encodeAnnouncementPayload('Alice', 'hi')!;
    const args = new Args(encoded);
    expect(args.nextString()).toBe('Alice');
    expect(args.nextString()).toBe('hi');
    expect(() => args.nextString()).toThrow();
  });

  it('encodes a contact request with nothing to state as a payload all the same', () => {
    // A contact request always carries a payload, so that a member of a
    // shared chat can tell it from the announcement of a connection, which
    // carries none (§5.12).
    const encoded = encodeContactRequestPayload('  ', '');
    expect(encoded.length).toBeGreaterThan(0);
    expect(decodeAnnouncementPayload(encoded)).toEqual({
      username: undefined,
      message: undefined,
    });
    expect(
      decodeAnnouncementPayload(encodeContactRequestPayload('Alice', 'hi'))
    ).toEqual({ username: 'Alice', message: 'hi' });
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
