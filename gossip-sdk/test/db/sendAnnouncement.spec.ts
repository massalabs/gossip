import { describe, it, expect } from 'vitest';
import {
  deserializeSendAnnouncement,
  serializeSendAnnouncement,
} from '../../src/db/db';

describe('queued announcement serialization', () => {
  const when_to_send = new Date('2026-10-19T10:00:00.000Z');
  const announcement_bytes = new Uint8Array([9, 8, 7]);

  it('reads entries written before addressed announcements existed', () => {
    const json = JSON.stringify({
      announcement_bytes: [9, 8, 7],
      when_to_send: when_to_send.toISOString(),
    });
    expect(deserializeSendAnnouncement(json)).toEqual({
      announcement_bytes,
      when_to_send,
    });
  });

  it('keeps the addressed entry without storing the announcement twice', () => {
    const mailbox = {
      seeker: new Uint8Array([1, 2]),
      data: new Uint8Array([3, 4, 9, 8, 7]),
    };
    const json = serializeSendAnnouncement({
      announcement_bytes,
      when_to_send,
      mailbox,
    });
    expect(JSON.parse(json).mailbox_prefix).toEqual([3, 4]);
    expect(deserializeSendAnnouncement(json)).toEqual({
      announcement_bytes,
      when_to_send,
      mailbox,
    });
  });
});
