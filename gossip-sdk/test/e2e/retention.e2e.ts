/**
 * E2E: Retention expiration in a chat of two — messages disappear at the
 * end of the chat's message timer
 *
 * Creates two accounts (Alice and Bob) whose contact request sets a short
 * message timer, so that the SDK founds their chat of two with it. Alice
 * sends a message; Bob receives it; both stop showing it once its timer
 * runs out. No clock is mocked: each SDK wakes itself at the message's
 * moment, from its own timer.
 *
 * Requires network. Run with: npm run test:e2e
 */

import { describe, it, expect, afterAll } from 'vitest';
import {
  createAccount,
  startChatOfTwo,
  sendAndReceive,
  messagesOf,
  cleanup,
  pollUntil,
} from './helpers';
import type { GossipSdk } from '../../src/gossip';

/**
 * The chat's message timer. Any positive value is taken; this one leaves a
 * slow API time to bring the message to Bob before it ends, and keeps the
 * test well under its timeout.
 */
const TIMER_MS = 30_000;
/** How late after its moment a message may still be shown (wake-up, polls). */
const LATE_MS = 10_000;

describe('E2E: Retention expiration in a chat of two (real API)', () => {
  let alice: GossipSdk | undefined;
  let bob: GossipSdk | undefined;

  afterAll(async () => {
    await cleanup(alice, bob);
  });

  it(
    'messages disappear on both sides after the message timer',
    { timeout: 240_000 },
    async () => {
      // ── 1. Create Alice and Bob; the contact request sets the timer ──
      alice = await createAccount();
      bob = await createAccount();
      expect(alice.userId).toMatch(/^gossip1/);
      expect(bob.userId).toMatch(/^gossip1/);
      expect(alice.userId).not.toBe(bob.userId);

      const groupId = await startChatOfTwo(alice, bob, TIMER_MS);
      for (const p of [alice, bob]) {
        expect((await p.groups.get(groupId))?.messageTimer).toBe(TIMER_MS);
      }

      // ── 2. Alice sends a message; Bob receives it before its moment ──
      const { sent, received } = await sendAndReceive(
        alice,
        bob,
        groupId,
        'Ephemeral message'
      );
      const moment = Number(sent.createdAt) + TIMER_MS;
      expect(Number(received.createdAt)).toBe(Number(sent.createdAt));
      expect(Date.now()).toBeLessThan(moment);

      // ── 3. Each side shows it until its moment, then no more ──
      await Promise.all(
        [alice, bob].map(async p => {
          let lastShown = 0;
          const goneAt = await pollUntil(
            async () => {
              // Shown: at least as late as the read began. Gone: at the
              // latest when it ended.
              const before = Date.now();
              const shown = (await messagesOf(p, groupId)).some(
                m => m.syncObjId === sent.syncObjId
              );
              if (shown) lastShown = before;
              return shown ? null : Date.now();
            },
            moment - Date.now() + LATE_MS,
            250,
            'the message to disappear'
          );
          expect(lastShown).toBeLessThan(moment);
          expect(goneAt).toBeGreaterThanOrEqual(moment);
        })
      );
    }
  );
});
