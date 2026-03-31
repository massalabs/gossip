/**
 * E2E Test Helpers
 *
 * Reusable helpers for SDK end-to-end tests. Every helper uses real network
 * calls — no mocks. Polling is disabled by default (SDK default); tests drive
 * sync manually via fetch() and updateState().
 *
 * Usage:
 *   import { createAccount, establishSession, sendAndReceive, cleanup, pollUntil } from './helpers';
 */

import { GossipSdk } from '../../src/gossip';
import type { Message } from '../../src/db';
import { DiscussionDirection } from '../../src/db';
import { SessionStatus } from '../../src/wasm/bindings';
import { generateMnemonic } from '../../src/crypto/bip39';
import { protocolConfig } from '../../src/config/protocol';
import { getTestStorageConfig } from '../testDb';

// ─────────────────────────────────────────────────────────────────────────────
// createAccount
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a real GossipSdk instance, initialise it against the live API,
 * and open a session with a freshly-generated mnemonic.
 *
 * Returns the SDK instance (session is open, userId is set).
 */
export async function createAccount(): Promise<GossipSdk> {
  const sdk = new GossipSdk();
  await sdk.init({
    protocolBaseUrl: protocolConfig.baseUrl,
    storage: getTestStorageConfig(),
  });

  const mnemonic = generateMnemonic();
  await sdk.openSession({ mnemonic });
  return sdk;
}

// ─────────────────────────────────────────────────────────────────────────────
// pollUntil
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Poll `fn` until it returns a truthy value, or throw after `timeoutMs`.
 *
 * @param fn        Async function to evaluate. Return a truthy value to stop.
 * @param timeoutMs Maximum wall-clock time to wait (default 30 s).
 * @param intervalMs Delay between polls (default 500 ms).
 * @returns The first truthy result from `fn`.
 */
export async function pollUntil<T>(
  fn: () => Promise<T>,
  timeoutMs = 30_000,
  intervalMs = 500
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result as NonNullable<T>;
    await new Promise(r => setTimeout(r, intervalMs));
  }

  throw new Error(`pollUntil timed out after ${timeoutMs} ms`);
}

// ─────────────────────────────────────────────────────────────────────────────
// establishSession
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Full session handshake between two accounts via the real API:
 *
 *   1. A fetches B's public key and adds B as a contact.
 *   2. A starts a discussion with B (sends announcement).
 *   3. B fetches announcements until the discussion request arrives.
 *   4. B accepts the discussion.
 *   5. Both sides run updateState() until the session is Active.
 *
 * When this resolves, both A and B have an Active session and can exchange
 * encrypted messages.
 */
export async function establishSession(
  a: GossipSdk,
  b: GossipSdk
): Promise<void> {
  const userAId = a.userId;
  const userBId = b.userId;

  // ── A adds B as a contact and starts a discussion ──
  const pubKeyB = await a.auth.fetchPublicKeyByUserId(userBId);
  await a.contacts.add(userBId, 'B', pubKeyB);
  const contactB = await a.contacts.get(userBId);
  if (!contactB) throw new Error('Failed to add contact B on A');

  await a.discussions.start(contactB, {
    username: 'A',
    message: 'session-init',
  });

  // ── B polls announcements until the discussion request from A arrives ──
  const discussionOnB = await pollUntil(async () => {
    await b.announcements.fetch();
    const discussions = await b.discussions.list();
    return discussions.find(
      d =>
        d.contactUserId === userAId &&
        d.direction === DiscussionDirection.RECEIVED
    );
  });

  // ── B accepts the discussion ──
  await b.discussions.accept(discussionOnB);

  // ── Both sides run updateState until the session is Active ──
  // A needs to fetch B's accept-announcement and process it.
  await pollUntil(async () => {
    await a.announcements.fetch();
    await a.updateState();
    return a.discussions.getStatus(userBId) === SessionStatus.Active;
  });

  await pollUntil(async () => {
    await b.updateState();
    return b.discussions.getStatus(userAId) === SessionStatus.Active;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// sendAndReceive
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Send a text message from `sender` to `receiver` and verify the receiver
 * gets it.
 *
 *   1. sender.messages.sendText(receiverUserId, text)
 *   2. sender.updateState() to encrypt + push
 *   3. Poll receiver.messages.fetch() until the message appears
 *
 * Returns the received Message object on the receiver side.
 */
export async function sendAndReceive(
  sender: GossipSdk,
  receiver: GossipSdk,
  text: string
): Promise<Message> {
  const receiverUserId = receiver.userId;
  const senderUserId = sender.userId;

  // Send
  const sendResult = await sender.messages.sendText(receiverUserId, text);
  if (!sendResult.success) {
    throw new Error(`sendText failed: ${sendResult.error}`);
  }
  await sender.updateState();

  // Receive — poll until the message shows up on the receiver
  const received = await pollUntil(async () => {
    await receiver.messages.fetch();
    const msgs = await receiver.messages.getVisibleMessages(senderUserId);
    return msgs.find(m => m.content === text);
  });

  return received;
}

// ─────────────────────────────────────────────────────────────────────────────
// cleanup
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Close all open sessions. Swallows errors so afterEach/afterAll never throws.
 */
export async function cleanup(...accounts: GossipSdk[]): Promise<void> {
  await Promise.allSettled(
    accounts.map(sdk => {
      if (sdk.isSessionOpen) return sdk.closeSession();
    })
  );
}
