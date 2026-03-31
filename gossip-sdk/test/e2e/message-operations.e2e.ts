/**
 * E2E: Message edit & delete operations
 *
 * Creates two accounts (Alice and Bob), establishes an encrypted session,
 * then verifies that edit and delete operations work correctly on real messages.
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
import { MessageType } from '../../src/db';

describe('E2E: Message edit & delete (real API)', () => {
  let alice: GossipSdk;
  let bob: GossipSdk;

  afterAll(async () => {
    await cleanup(alice, bob);
  });

  it(
    'edit message -> content updated, metadata.edited = true',
    { timeout: 120_000 },
    async () => {
      // ── 1. Create Alice and Bob accounts ──
      alice = await createAccount();
      bob = await createAccount();

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

      // ── 3. Alice sends "Original text" to Bob ──
      await sendAndReceive(alice, bob, 'Original text');

      // ── 4. Find the message in Alice's DB ──
      const aliceMessages = await alice.messages.getVisibleMessages(bob.userId);
      const original = aliceMessages.find(m => m.content === 'Original text');
      expect(original).toBeDefined();
      expect(original!.id).toBeDefined();

      // ── 5. Alice edits the message ──
      const editResult = await alice.messages.editMessage(
        original!.id!,
        'Edited text'
      );
      expect(editResult).toBe(true);

      // ── 6. Verify edited content and metadata ──
      const edited = await alice.messages.get(original!.id!);
      expect(edited).toBeDefined();
      expect(edited!.content).toBe('Edited text');
      expect(edited!.metadata?.edited).toBe(true);
    }
  );

  it(
    'delete message -> type becomes DELETED, not in visible messages',
    { timeout: 120_000 },
    async () => {
      // Re-use the session from the previous test (alice & bob are still connected)

      // ── 1. Alice sends "Message to delete" to Bob ──
      await sendAndReceive(alice, bob, 'Message to delete');

      // ── 2. Find it in Alice's messages ──
      const aliceMessages = await alice.messages.getMessages(bob.userId);
      const toDelete = aliceMessages.find(
        m => m.content === 'Message to delete'
      );
      expect(toDelete).toBeDefined();
      expect(toDelete!.id).toBeDefined();

      // ── 3. Delete the message ──
      const deleteResult = await alice.messages.deleteMessage(toDelete!.id!);
      expect(deleteResult).toBe(true);

      // ── 4. Verify type is DELETED and content replaced ──
      const deleted = await alice.messages.get(toDelete!.id!);
      expect(deleted).toBeDefined();
      expect(deleted!.type).toBe(MessageType.DELETED);
      expect(deleted!.content).toBe('[Message deleted]');

      // ── 5. Verify visible messages shows it as deleted (placeholder text) ──
      // The original message stays in getVisibleMessages with the placeholder
      // content — only the outgoing control message (empty content) is hidden.
      const visibleMessages = await alice.messages.getVisibleMessages(
        bob.userId
      );
      const found = visibleMessages.find(m => m.id === toDelete!.id);
      expect(found).toBeDefined();
      expect(found!.type).toBe(MessageType.DELETED);
      expect(found!.content).toBe('[Message deleted]');
    }
  );
});
