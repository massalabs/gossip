#!/usr/bin/env npx tsx
/**
 * Gossip SDK — Two-account messaging demo (Node.js, real protocol)
 *
 * Each SDK instance owns its own DatabaseConnection, so Alice and Bob
 * can run simultaneously in the same process with separate databases.
 *
 * End-to-end flow over the live API (https://api.usegossip.com):
 *   1. Alice opens session (publishes public keys)
 *   2. Bob opens session (publishes public keys)
 *   3. Alice starts a discussion with Bob (simplified API)
 *   4. Bob polls for announcement → accepts
 *   5. Alice polls for acceptance → session active
 *   6. Alice sends a message → Bob polls until received
 *   7. Bob replies → Alice polls until received
 *   8. Close, reopen Alice → verify persistence
 *
 * Usage:
 *   npx tsx gossip-sdk/examples/node-messaging-demo.ts
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { GossipSdk, SessionStatus, type StorageConfig } from '../src';
import { MessageDirection } from '../src/db';

// ── Config ────────────────────────────────────────────────────────
const DB_DIR = path.join(path.dirname('./'), 'messaging-db.local');

const ALICE_STORAGE: StorageConfig = {
  type: 'node-fs',
  path: path.join(DB_DIR, 'alice'),
};

const BOB_STORAGE: StorageConfig = {
  type: 'node-fs',
  path: path.join(DB_DIR, 'bob'),
};

// Fixed mnemonics so identities persist across restarts
const ALICE_MNEMONIC =
  'cool cool cool cool cool cool cool cool cool cool cool man';

const BOB_MNEMONIC = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo cat';

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 60_000;

const ALICE_MESSAGE = 'Hey Bob, want to chat?';
const BOB_MESSAGE = 'Hey Alice I love you!';

// ── Helpers ───────────────────────────────────────────────────────

/** Open an SDK instance with its own database. */
async function openSdk(
  mnemonic: string,
  storage: StorageConfig
): Promise<GossipSdk> {
  const sdk = await new GossipSdk().init({ storage });
  await sdk.openSession({
    mnemonic,
    onPersist: async () => {},
    // TODO: add option skipHistorical
  });
  await sdk.announcements.skipHistorical();

  return sdk;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function waitForSessionStatus(
  sdk: GossipSdk,
  contactUserId: string,
  targetStatus: SessionStatus
): Promise<boolean> {
  const statusName = SessionStatus[targetStatus];
  const start = Date.now();
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    await sdk.announcements.fetch();
    const status = sdk.discussions.getStatus(contactUserId);
    if (status === targetStatus) {
      console.log(`   ✓ session status: ${statusName}`);
      console.log();
      return true;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Timeout: expected status ${statusName}, never reached`);
}

async function waitNextMessage(
  sdk: GossipSdk,
  contactUserId: string
): Promise<boolean> {
  const start = Date.now();
  let found = false;
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    await sdk.messages.fetch();
    const msgs = await sdk.messages.getMessages(contactUserId);
    if (
      msgs.some(m => m.direction === MessageDirection.INCOMING && m.content)
    ) {
      found = true;
      break;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  if (!found) throw new Error('Timeout: No message received');

  const messages = await sdk.messages.getMessages(contactUserId);
  for (const m of messages) {
    const arrow =
      m.direction === MessageDirection.OUTGOING ? '\u2192' : '\u2190';
    console.log(`   ${arrow} "${m.content}" (${m.status})`);
  }
  console.log();
  return true;
}

// ── Main ──────────────────────────────────────────────────────────

async function main() {
  // Clean up previous run
  if (fs.existsSync(DB_DIR)) {
    fs.rmSync(DB_DIR, { recursive: true });
  }
  console.log('Database directory:', DB_DIR, '\n');

  // ── Step 1: Alice opens session ─────────────────────────────────
  const alice = await openSdk(ALICE_MNEMONIC, ALICE_STORAGE);
  // ── Step 2: Bob opens session ───────────────────────────────────
  const bob = await openSdk(BOB_MNEMONIC, BOB_STORAGE);
  // ── Step 3: Alice starts discussion with Bob ─────────────────────
  const startResult = await alice.discussions.startByUserId(bob.userId, 'Bob', {
    username: 'Alice',
    message: ALICE_MESSAGE,
  });

  if (!startResult.success)
    throw new Error(`Start discussion failed: ${startResult.error}`);

  // ── Step 4: Bob polls for announcement + accepts ────────────────
  await waitForSessionStatus(bob, alice.userId, SessionStatus.PeerRequested);

  const bobDiscussions = await bob.discussions.list();
  const fromAlice = bobDiscussions.find(d => d.contactUserId === alice.userId);

  if (!fromAlice) throw new Error('Bob has no discussion from Alice');

  const acceptResult = await bob.discussions.accept(fromAlice);
  if (!acceptResult.success)
    throw new Error(`Accept failed: ${acceptResult.error}`);

  // ── Step 5: Alice polls for acceptance ──────────────────────────
  await waitForSessionStatus(alice, bob.userId, SessionStatus.Active);

  // ── Step 6: Alice sends a message (simplified API) ──────────────
  await alice.messages.sendText(bob.userId, 'Hello Bob!');

  // ── Step 7: Bob polls for Alice's message ──────────────────────
  await waitNextMessage(bob, alice.userId);

  // ── Step 8: Bob replies (simplified API) ───────────────────────
  await bob.messages.sendText(alice.userId, BOB_MESSAGE);

  // ── Step 9: Alice polls for reply ──────────────────────────────
  await waitNextMessage(alice, bob.userId);

  // Save IDs before destroying (getters throw after destroy)
  const bobId = bob.userId;

  // ── Step 10: Destroy both instances ─────────────────────────────
  await alice.destroy();
  await bob.destroy();

  // ── Step 11: Reopen Alice to verify persistence ─────────────────
  const alice2 = await openSdk(ALICE_MNEMONIC, ALICE_STORAGE);

  const persisted = await alice2.messages.getMessages(bobId);

  for (const m of persisted) {
    const arrow =
      m.direction === MessageDirection.OUTGOING ? '\u2192' : '\u2190';
    console.log(`      ${arrow} "${m.content}" (${m.status})`);
  }

  await alice2.destroy();
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
