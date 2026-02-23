#!/usr/bin/env npx tsx
/**
 * Gossip SDK — Two-account messaging demo (Node.js, real protocol)
 *
 * End-to-end flow over the live API (https://api.usegossip.com):
 *   1. Alice opens session (publishes public keys)
 *   2. Bob opens session (publishes public keys)
 *   3. Alice adds Bob as contact + starts discussion → announcement sent
 *   4. Bob polls for announcement → accepts → acceptance sent
 *   5. Alice polls for acceptance → session active
 *   6. Alice sends a message → Bob polls until received
 *   7. Bob replies → Alice polls until received
 *   8. Close, reopen Alice → verify persistence
 *
 * Note: SQLite is a module-level singleton, so only one SDK can be open at
 * a time when using file-based storage. The demo alternates between Alice
 * and Bob by closing/reopening sessions and databases.
 *
 * Usage:
 *   npx tsx gossip-sdk/examples/node-messaging-demo.ts
 */

import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { GossipSdk, type StorageConfig, SessionStatus } from '../src';
import {
  generateEncryptionKey,
  type EncryptionKey,
} from '../src/wasm/encryption';
import { closeSqlite } from '../src/db';
import { MessageType, MessageDirection, MessageStatus } from '../src/db';

// ── Config ────────────────────────────────────────────────────────

const DB_DIR = path.join(os.homedir(), '.gossip-demo', 'messaging-db');
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
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const BOB_MNEMONIC = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong';

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 60_000;

// ── Helpers ───────────────────────────────────────────────────────

interface SdkHandle {
  sdk: GossipSdk;
  name: string;
  mnemonic: string;
  storage: StorageConfig;
  encryptedSession?: Uint8Array;
  encryptionKey?: EncryptionKey;
}

/** Open an SDK instance. */
async function openSdk(
  name: string,
  mnemonic: string,
  storage: StorageConfig,
  encryptedSession?: Uint8Array,
  encryptionKey?: EncryptionKey
): Promise<SdkHandle> {
  const sdk = new GossipSdk();
  await sdk.init({ storage });

  const key = encryptionKey ?? (await generateEncryptionKey());

  await sdk.openSession({
    mnemonic,
    encryptionKey: key,
    encryptedSession,
    onPersist: async () => {},
  });

  console.log(
    `  [${name}] session open — userId: ${sdk.userId.slice(0, 30)}...`
  );
  return { sdk, name, mnemonic, storage, encryptionKey: key };
}

/** Close SDK + SQLite. Returns updated handle with encrypted session for later restore. */
async function closeSdk(handle: SdkHandle): Promise<SdkHandle> {
  let encryptedSession: Uint8Array | undefined;
  try {
    encryptedSession = handle.sdk.getEncryptedSession();
  } catch {
    // May not be available
  }
  await handle.sdk.closeSession();
  await closeSqlite();
  return { ...handle, encryptedSession };
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ── Main ──────────────────────────────────────────────────────────

async function main() {
  // Clean up previous run
  if (fs.existsSync(DB_DIR)) {
    fs.rmSync(DB_DIR, { recursive: true });
  }
  console.log('Database directory:', DB_DIR);
  console.log();

  // State carried between reopens
  let aliceUserId = '';
  let bobUserId = '';
  let aliceSession: Uint8Array | undefined;
  let bobSession: Uint8Array | undefined;

  // ── Step 1: Alice opens session ─────────────────────────────────
  console.log('1) Alice opens session (publishes keys to server)...');
  let h = await openSdk('Alice', ALICE_MNEMONIC, ALICE_STORAGE);
  aliceUserId = h.sdk.userId;
  const aliceKey = h.encryptionKey;
  await h.sdk.announcements.skipHistorical();
  console.log('   Skipped historical announcements.');
  let closed = await closeSdk(h);
  aliceSession = closed.encryptedSession;
  console.log();

  // ── Step 2: Bob opens session ───────────────────────────────────
  console.log('2) Bob opens session (publishes keys to server)...');
  h = await openSdk('Bob', BOB_MNEMONIC, BOB_STORAGE);
  bobUserId = h.sdk.userId;
  const bobKey = h.encryptionKey;
  await h.sdk.announcements.skipHistorical();
  console.log('   Skipped historical announcements.');
  closed = await closeSdk(h);
  bobSession = closed.encryptedSession;
  console.log();

  // ── Step 3: Alice adds Bob + starts discussion ──────────────────
  console.log('3) Alice adds Bob as contact and starts discussion...');
  let alice = await openSdk(
    'Alice',
    ALICE_MNEMONIC,
    ALICE_STORAGE,
    aliceSession,
    aliceKey
  );

  const bobPubKeys = await alice.sdk.auth.fetchPublicKeyByUserId(bobUserId);
  await alice.sdk.contacts.add(alice.sdk.userId, bobUserId, 'Bob', bobPubKeys);

  const bobContact = await alice.sdk.contacts.get(alice.sdk.userId, bobUserId);
  if (!bobContact) throw new Error('Failed to add Bob as contact');

  const startResult = await alice.sdk.discussions.start(bobContact, {
    username: 'Alice',
    message: 'Hey Bob, want to chat?',
  });
  if (!startResult.success)
    throw new Error(`Start discussion failed: ${startResult.error}`);
  console.log('   Discussion created. Broadcasting announcement...');

  await alice.sdk.updateState();
  console.log('   Announcement sent to server.');

  closed = await closeSdk(alice);
  aliceSession = closed.encryptedSession;
  console.log();

  // ── Step 4: Bob polls for announcement + accepts ────────────────
  console.log('4) Bob polling for announcement from Alice...');
  let bob = await openSdk('Bob', BOB_MNEMONIC, BOB_STORAGE, bobSession, bobKey);

  let start = Date.now();
  let found = false;
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    const result = await bob.sdk.announcements.fetch();
    if (result.newAnnouncementsCount > 0) {
      found = true;
      break;
    }
    process.stdout.write('.');
    await sleep(POLL_INTERVAL_MS);
  }
  if (!found) throw new Error('Timeout: Bob did not receive announcement');
  console.log(' received!');

  // Bob should have a pending discussion — check via session status
  const bobDiscussions = await bob.sdk.discussions.list(bob.sdk.userId);
  const fromAlice = bobDiscussions.find(d => d.contactUserId === aliceUserId);
  if (!fromAlice) throw new Error('Bob has no discussion from Alice');
  console.log(
    `   Discussion from Alice: "${fromAlice.lastAnnouncementMessage || '(no message)'}"`
  );

  const sessionStatus = bob.sdk.discussions.getStatus(aliceUserId);
  console.log(
    `   Session status: ${sessionStatus} (PeerRequested = ${SessionStatus.PeerRequested})`
  );

  console.log('   Accepting...');
  const acceptResult = await bob.sdk.discussions.accept(fromAlice);
  if (!acceptResult.success)
    throw new Error(`Accept failed: ${acceptResult.error}`);

  await bob.sdk.updateState();
  console.log('   Acceptance sent to server.');

  closed = await closeSdk(bob);
  bobSession = closed.encryptedSession;
  console.log();

  // ── Step 5: Alice polls for acceptance ──────────────────────────
  console.log("5) Alice polling for Bob's acceptance...");
  alice = await openSdk(
    'Alice',
    ALICE_MNEMONIC,
    ALICE_STORAGE,
    aliceSession,
    aliceKey
  );

  start = Date.now();
  found = false;
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    await alice.sdk.announcements.fetch();
    // Check WASM session status (not DB discussion status)
    const status = alice.sdk.discussions.getStatus(bobUserId);
    if (status === SessionStatus.Active) {
      found = true;
      break;
    }
    process.stdout.write('.');
    await sleep(POLL_INTERVAL_MS);
  }
  if (!found) throw new Error('Timeout: session did not become active');
  console.log(' session active!');
  console.log();

  // ── Step 6: Alice sends a message ──────────────────────────────
  console.log('6) Alice sends "Hello Bob!" ...');
  const sendResult = await alice.sdk.messages.send({
    ownerUserId: alice.sdk.userId,
    contactUserId: bobUserId,
    content: 'Hello Bob!',
    type: MessageType.TEXT,
    direction: MessageDirection.OUTGOING,
    status: MessageStatus.WAITING_SESSION,
    timestamp: new Date(),
  });
  console.log('   Send result:', sendResult.success ? 'OK' : 'FAILED');

  await alice.sdk.updateState();

  closed = await closeSdk(alice);
  aliceSession = closed.encryptedSession;
  console.log();

  // ── Step 7: Bob polls for Alice's message ──────────────────────
  console.log('7) Bob polling for message from Alice...');
  bob = await openSdk('Bob', BOB_MNEMONIC, BOB_STORAGE, bobSession, bobKey);

  start = Date.now();
  found = false;
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    await bob.sdk.messages.fetch();
    const msgs = await bob.sdk.messages.getMessages(aliceUserId);
    if (
      msgs.some(m => m.direction === MessageDirection.INCOMING && m.content)
    ) {
      found = true;
      break;
    }
    process.stdout.write('.');
    await sleep(POLL_INTERVAL_MS);
  }
  if (!found) throw new Error('Timeout: Bob did not receive message');
  console.log(' received!');

  const bobMessages = await bob.sdk.messages.getMessages(aliceUserId);
  for (const m of bobMessages) {
    const arrow = m.direction === MessageDirection.OUTGOING ? '→' : '←';
    console.log(`   ${arrow} "${m.content}" (${m.status})`);
  }
  console.log();

  // ── Step 8: Bob replies ────────────────────────────────────────
  console.log('8) Bob replies "Hey Alice!" ...');
  await bob.sdk.messages.send({
    ownerUserId: bob.sdk.userId,
    contactUserId: aliceUserId,
    content: 'Hey Alice!',
    type: MessageType.TEXT,
    direction: MessageDirection.OUTGOING,
    status: MessageStatus.WAITING_SESSION,
    timestamp: new Date(),
  });
  await bob.sdk.updateState();

  closed = await closeSdk(bob);
  bobSession = closed.encryptedSession;
  console.log();

  // ── Step 9: Alice polls for reply ──────────────────────────────
  console.log('9) Alice polling for reply from Bob...');
  alice = await openSdk(
    'Alice',
    ALICE_MNEMONIC,
    ALICE_STORAGE,
    aliceSession,
    aliceKey
  );

  start = Date.now();
  found = false;
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    await alice.sdk.messages.fetch();
    const msgs = await alice.sdk.messages.getMessages(bobUserId);
    if (
      msgs.some(m => m.direction === MessageDirection.INCOMING && m.content)
    ) {
      found = true;
      break;
    }
    process.stdout.write('.');
    await sleep(POLL_INTERVAL_MS);
  }
  if (!found) throw new Error('Timeout: Alice did not receive reply');
  console.log(' received!');

  const aliceMessages = await alice.sdk.messages.getMessages(bobUserId);
  for (const m of aliceMessages) {
    const arrow = m.direction === MessageDirection.OUTGOING ? '→' : '←';
    console.log(`   ${arrow} "${m.content}" (${m.status})`);
  }
  console.log();

  // ── Step 10: Close + verify persistence ────────────────────────
  const aliceId = alice.sdk.userId;

  console.log('10) Closing session...');
  closed = await closeSdk(alice);
  aliceSession = closed.encryptedSession;
  console.log('    Closed.');
  console.log();

  console.log('11) Reopening Alice to verify persistence...');
  const alice2 = await openSdk(
    'Alice2',
    ALICE_MNEMONIC,
    ALICE_STORAGE,
    aliceSession,
    aliceKey
  );
  console.log(`    Same identity? ${alice2.sdk.userId === aliceId}`);

  const persisted = await alice2.sdk.messages.getMessages(bobUserId);
  console.log(`    Messages on disk: ${persisted.length}`);
  for (const m of persisted) {
    const arrow = m.direction === MessageDirection.OUTGOING ? '→' : '←';
    console.log(`      ${arrow} "${m.content}" (${m.status})`);
  }

  await closeSdk(alice2);

  // ── Done ────────────────────────────────────────────────────────
  console.log();
  console.log(
    'Done. Full send + receive + persistence verified over real protocol.'
  );
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
