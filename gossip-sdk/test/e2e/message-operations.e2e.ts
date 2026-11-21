/**
 * E2E: Message edit & delete operations in a chat of two
 *
 * Creates two accounts (Alice and Bob), makes them contacts so that the SDK
 * founds their chat of two, then verifies that an edit and a deletion for
 * everyone by Alice reach Bob through the real API.
 *
 * Requires network. Run with: npm run test:e2e
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createAccount,
  startChatOfTwo,
  sendAndReceive,
  messagesOf,
  textOf,
  cleanup,
  pollUntil,
} from './helpers';
import type { GossipSdk } from '../../src/gossip';
import type { GroupId } from '../../src/services/groups';

/** The chat's message timer: long enough to play no part here. */
const ONE_HOUR = 3_600_000;

describe('E2E: Message edit & delete in a chat of two (real API)', () => {
  let alice: GossipSdk | undefined;
  let bob: GossipSdk | undefined;
  let groupId: GroupId;

  beforeAll(async () => {
    alice = await createAccount();
    bob = await createAccount();
    groupId = await startChatOfTwo(alice, bob, ONE_HOUR);
  }, 180_000);

  afterAll(async () => {
    await cleanup(alice, bob);
  });

  it(
    'edit message -> content updated and marked edited on both sides',
    { timeout: 120_000 },
    async () => {
      const [a, b] = [alice!, bob!];
      expect((await a.groups.get(groupId))?.messageTimer).toBe(ONE_HOUR);
      expect((await b.groups.get(groupId))?.messageTimer).toBe(ONE_HOUR);

      // ── 1. Alice sends "Original text"; Bob receives it ──
      const { sent, received } = await sendAndReceive(
        a,
        b,
        groupId,
        'Original text'
      );
      expect(textOf(received)).toBe('Original text');
      expect(received.author).toBe(a.userId);
      expect(received.edited).toBe(false);

      // ── 2. Alice edits it ──
      await a.groups.editMessage(sent.epochId, sent.syncObjId, 'Edited text');

      // ── 3. Both show the new content, marked edited, in place ──
      for (const p of [a, b]) {
        const edited = await pollUntil(
          async () =>
            (await messagesOf(p, groupId)).find(
              m => m.syncObjId === sent.syncObjId && m.edited
            ),
          60_000,
          500,
          'the edit'
        );
        expect(textOf(edited)).toBe('Edited text');
        expect(
          (await messagesOf(p, groupId)).filter(
            m => m.syncObjId === sent.syncObjId
          )
        ).toHaveLength(1);
      }
    }
  );

  it(
    'delete message for everyone -> no longer shown on either side',
    { timeout: 120_000 },
    async () => {
      const [a, b] = [alice!, bob!];

      // ── 1. Alice sends "Message to delete" and "Message kept"; Bob gets both ──
      const { sent: toDelete } = await sendAndReceive(
        a,
        b,
        groupId,
        'Message to delete'
      );
      const { sent: kept } = await sendAndReceive(
        a,
        b,
        groupId,
        'Message kept'
      );

      // ── 2. Alice deletes the first for everyone ──
      await a.groups.deleteMessage(toDelete.epochId, toDelete.syncObjId);

      // ── 3. Neither side shows it any more; the other message stays ──
      for (const p of [a, b]) {
        await pollUntil(
          async () =>
            !(await messagesOf(p, groupId)).some(
              m => m.syncObjId === toDelete.syncObjId
            ),
          60_000,
          500,
          'the deletion'
        );
        const shown = await messagesOf(p, groupId);
        expect(shown.map(textOf)).not.toContain('Message to delete');
        expect(shown.some(m => m.syncObjId === kept.syncObjId)).toBe(true);
      }
    }
  );
});
