import { describe, it, expect, beforeEach } from 'vitest';
import {
  MAX_PENDING_PER_SEEKER,
  MAX_PENDING_ROWS,
} from '../../src/db/queries/pendingEncryptedMessages';
import { clearAllTables, getTestQueries } from '../testDb';

const seeker = (n: number) => new Uint8Array([n & 0xff, n >> 8]);
const value = (n: number) => new Uint8Array([n & 0xff, n >> 8, 7]);

describe('pushed message inbox', () => {
  beforeEach(async () => {
    await clearAllTables();
  });

  it('keeps a few distinct values per seeker, first come first kept', async () => {
    const pending = getTestQueries().pendingEncryptedMessages;
    const junk = Array.from({ length: 10 }, (_, i) => ({
      seeker: seeker(1),
      ciphertext: value(i),
    }));
    expect(await pending.insertNew(junk)).toBe(MAX_PENDING_PER_SEEKER);
    expect(
      await pending.insertNew([{ seeker: seeker(1), ciphertext: value(99) }])
    ).toBe(0);
    const rows = await pending.getBySeekers([seeker(1)]);
    expect(rows.map(r => r.ciphertext)).toEqual(
      junk.slice(0, MAX_PENDING_PER_SEEKER).map(m => m.ciphertext)
    );
  });

  it('drops the oldest rows beyond the overall cap', async () => {
    const pending = getTestQueries().pendingEncryptedMessages;
    const messages = Array.from({ length: MAX_PENDING_ROWS + 5 }, (_, i) => ({
      seeker: seeker(i),
      ciphertext: value(i),
    }));
    await pending.insertNew(messages);
    expect(await pending.getBySeekers([seeker(0)])).toHaveLength(0);
    expect(
      await pending.getBySeekers([seeker(MAX_PENDING_ROWS + 4)])
    ).toHaveLength(1);
  });

  it('forgets rows at seekers no longer waited on', async () => {
    const pending = getTestQueries().pendingEncryptedMessages;
    await pending.insertNew([
      { seeker: seeker(1), ciphertext: value(1) },
      { seeker: seeker(2), ciphertext: value(2) },
    ]);
    await pending.deleteExceptSeekers([seeker(2)]);
    expect(await pending.getBySeekers([seeker(1), seeker(2)])).toHaveLength(1);
  });
});
