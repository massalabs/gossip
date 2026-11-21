import { describe, it, expect } from 'vitest';
import { placeIncomingMessage } from '../../src/services/message';

const now = Date.parse('2026-10-20T12:00:00Z');
const minutes = (n: number) => n * 60 * 1000;

describe('placeIncomingMessage', () => {
  it('keeps the sender date of a message read on time', () => {
    const sentAt = new Date(now - minutes(1));
    expect(placeIncomingMessage(sentAt, false, now)).toEqual({
      timestamp: sentAt,
      delayed: false,
      untrustedSentAt: false,
    });
  });

  it('keeps the sender date but marks a message that waited in transit', () => {
    const sentAt = new Date(now - minutes(45));
    expect(placeIncomingMessage(sentAt, false, now)).toEqual({
      timestamp: sentAt,
      delayed: true,
      untrustedSentAt: false,
    });
  });

  it('places a stale message at the time it was read', () => {
    // dated before the previous message: the sender clock cannot place it
    const sentAt = new Date(now - minutes(60 * 24 * 30));
    expect(placeIncomingMessage(sentAt, true, now)).toEqual({
      timestamp: new Date(now),
      delayed: true,
      untrustedSentAt: true,
    });
  });

  it('places a future-dated message at the time it was read', () => {
    const sentAt = new Date(now + minutes(60 * 20));
    expect(placeIncomingMessage(sentAt, false, now)).toEqual({
      timestamp: new Date(now),
      delayed: true,
      untrustedSentAt: true,
    });
    // a little skew is tolerated
    const skewed = new Date(now + 30 * 1000);
    expect(placeIncomingMessage(skewed, false, now).timestamp).toEqual(skewed);
  });
});
