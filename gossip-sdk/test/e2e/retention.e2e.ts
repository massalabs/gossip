/**
 * E2E: Retention expiration — messages disappear after the retention period
 *
 * Creates two accounts (Alice and Bob), establishes an encrypted session,
 * sets a short retention policy, sends a message, waits for it to expire,
 * then verifies it is deleted by deleteExpiredMessages.
 *
 * Requires network. Run with: npm run test:e2e
 */

import { describe, it, expect, afterAll } from 'vitest';
import {
  createAccount,
  establishSession,
  sendAndReceive,
  cleanup,
  pollUntil,
} from './helpers';
import type { GossipSdk } from '../../src/gossip';

describe('E2E: Retention expiration (real API)', () => {
  let alice: GossipSdk;
  let bob: GossipSdk;

  afterAll(async () => {
    await cleanup(alice, bob);
  });

  it(
    'messages disappear after retention period',
    { timeout: 120_000 },
    async () => {
      // ── 1. Create Alice and Bob accounts ──
      alice = await createAccount();
      bob = await createAccount();

      expect(alice.userId).toMatch(/^gossip1/);
      expect(bob.userId).toMatch(/^gossip1/);
      expect(alice.userId).not.toBe(bob.userId);

      // ── 2. Wait for public keys to propagate, then establish session ──
      await pollUntil(
        async () => {
          try {
            await alice.auth.fetchPublicKeyByUserId(bob.userId);
            return true;
          } catch {
            return false;
          }
        },
        15_000,
        1_000
      );

      await establishSession(alice, bob);

      // ── 3. Set very short retention (5 seconds) on Alice's side ──
      await alice.discussions.setRetentionPolicy(bob.userId, 5);

      // ── 4. Send a message and verify it exists ──
      const msg = await sendAndReceive(alice, bob, 'Ephemeral message');
      expect(msg.content).toBe('Ephemeral message');

      // Verify message exists in Alice's visible messages
      const beforeMessages = await alice.messages.getVisibleMessages(
        bob.userId
      );
      const found = beforeMessages.find(m => m.content === 'Ephemeral message');
      expect(found).toBeDefined();

      // ── 5. Wait 7 seconds (5s retention + 2s buffer) ──
      await new Promise(r => setTimeout(r, 7_000));

      // ── 6. Trigger cleanup ──
      await alice.messages.deleteExpiredMessages(alice.userId);

      // ── 7. Verify message is gone from visible messages ──
      const afterMessages = await alice.messages.getVisibleMessages(bob.userId);
      const gone = afterMessages.find(m => m.content === 'Ephemeral message');
      expect(gone).toBeUndefined();
    }
  );
});
