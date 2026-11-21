/**
 * E2E Test Helpers
 *
 * Reusable helpers for SDK end-to-end tests. Every helper uses real network
 * calls — no mocks. Accounts run the SDK's own polling (messages,
 * announcements, session refresh and session statuses), as the app does:
 * a chat of two is founded by the SDK once a contact request is accepted,
 * which needs the session statuses that only polling reports.
 *
 * Usage:
 *   import { createAccount, startChatOfTwo, sendAndReceive, cleanup, pollUntil } from './helpers';
 */

import { GossipSdk } from '../../src/gossip';
import { DiscussionDirection } from '../../src/db';
import type { GroupId, GroupMessage } from '../../src/services/groups';
import { generateMnemonic } from '../../src/crypto/bip39';
import { protocolConfig } from '../../src/config/protocol';
import { getTestStorageConfig } from '../testDb';

/**
 * Polling intervals of the test accounts: shorter than the SDK's defaults so
 * that a round trip takes seconds, and well within the API's rate limits
 * for two accounts on one address.
 */
const POLLING = {
  enabled: true,
  messagesIntervalMs: 1_000,
  announcementsIntervalMs: 1_000,
  sessionRefreshIntervalMs: 5_000,
};

// ─────────────────────────────────────────────────────────────────────────────
// createAccount
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a real GossipSdk instance, initialise it against the live API,
 * and open a session with a freshly-generated mnemonic. Polling starts once
 * the account's bulletin cursor is set.
 *
 * Returns the SDK instance (session is open, userId is set).
 */
export async function createAccount(): Promise<GossipSdk> {
  const sdk = new GossipSdk();
  await sdk.init({
    protocolBaseUrl: protocolConfig.baseUrl,
    storage: getTestStorageConfig(),
    config: { polling: POLLING },
  });

  // As the app does for a new account: the bulletin's history, which a new
  // account cannot read, is skipped rather than fetched page by page.
  const counter = sdk.prefetchBulletinCounter();
  const mnemonic = generateMnemonic();
  await sdk.openSession({ mnemonic, autoStartPolling: false });
  await sdk.announcements.skipHistorical(counter);
  sdk.polling.start();
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
 * @param what      What is awaited, for the error.
 * @returns The first truthy result from `fn`.
 */
export async function pollUntil<T>(
  fn: () => Promise<T>,
  timeoutMs = 30_000,
  intervalMs = 500,
  what = ''
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result as NonNullable<T>;
    await new Promise(r => setTimeout(r, intervalMs));
  }

  throw new Error(
    `pollUntil timed out after ${timeoutMs} ms${what ? `: ${what}` : ''}`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// startChatOfTwo
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Makes `a` and `b` contacts through the real API and waits for the chat of
 * two the SDK founds for them, as a user does:
 *
 *   1. A fetches B's public key and sends B a contact request carrying the
 *      message timer of the chat to come.
 *   2. B's polling receives the request, which shows that timer; B accepts.
 *   3. Both sides hold the same chat of two, B a member without a second
 *      prompt (no invitation to accept).
 *
 * Returns the chat's group key.
 */
export async function startChatOfTwo(
  a: GossipSdk,
  b: GossipSdk,
  messageTimer: number
): Promise<GroupId> {
  // ── B's public key may take a moment to be readable ──
  const pubKeyB = await pollUntil(
    async () => {
      try {
        return await a.auth.fetchPublicKeyByUserId(b.userId);
      } catch {
        return null;
      }
    },
    30_000,
    1_000,
    "B's public key"
  );
  await a.contacts.add(b.userId, 'B', pubKeyB);
  const contactB = await a.contacts.get(b.userId);
  if (!contactB) throw new Error('Failed to add contact B on A');

  // ── A sends the contact request, with the timer of the chat ──
  const started = await a.discussions.start(
    contactB,
    { username: 'A', message: 'hello' },
    { messageTimer }
  );
  if (!started.success) {
    throw new Error(`Contact request failed: ${started.error}`);
  }

  // ── B receives it and accepts ──
  const request = await pollUntil(
    async () => {
      const d = await b.discussions.get(a.userId);
      return d?.direction === DiscussionDirection.RECEIVED ? d : null;
    },
    60_000,
    500,
    'the contact request on B'
  );
  if (request.directChatTimer !== messageTimer) {
    throw new Error(
      `B sees the timer ${request.directChatTimer}, not ${messageTimer}`
    );
  }
  const accepted = await b.discussions.accept(request);
  if (!accepted.success) {
    throw new Error(`Accepting the request failed: ${accepted.error}`);
  }

  // ── The same chat of two appears on both sides, B already a member ──
  return pollUntil(
    async () => {
      const onA = await a.conversations.directChatWith(b.userId);
      const onB = await b.conversations.directChatWith(a.userId);
      if (!onA || onA !== onB) return null;
      const [chatA, chatB] = await Promise.all([
        a.groups.get(onA),
        b.groups.get(onB),
      ]);
      return chatA?.status === 'member' && chatB?.status === 'member'
        ? onA
        : null;
    },
    90_000,
    500,
    'the chat of two on both sides'
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// messagesOf / sendAndReceive
// ─────────────────────────────────────────────────────────────────────────────

/** The messages `sdk` shows in the chat `groupId`, oldest first. */
export async function messagesOf(
  sdk: GossipSdk,
  groupId: GroupId
): Promise<GroupMessage[]> {
  return (await sdk.groups.timeline(groupId)).filter(
    (i): i is GroupMessage => i.kind === 'message'
  );
}

/** The text of a message, or null for another kind. */
export function textOf(m: GroupMessage): string | null {
  return m.body.type === 'text' ? m.body.text : null;
}

/**
 * Sends `text` from `sender` in the chat `groupId` and waits until
 * `receiver` shows it.
 *
 * Returns the message as the sender and as the receiver show it.
 */
export async function sendAndReceive(
  sender: GossipSdk,
  receiver: GossipSdk,
  groupId: GroupId,
  text: string
): Promise<{ sent: GroupMessage; received: GroupMessage }> {
  const published = await sender.groups.sendMessage(groupId, text);
  const sent = (await messagesOf(sender, groupId)).find(
    m => m.syncObjId === published.syncObjId
  );
  if (!sent) throw new Error(`"${text}" is not shown to its sender`);

  const received = await pollUntil(
    async () =>
      (await messagesOf(receiver, groupId)).find(
        m => m.syncObjId === published.syncObjId
      ),
    60_000,
    500,
    `"${text}" on the receiver`
  );
  return { sent, received };
}

// ─────────────────────────────────────────────────────────────────────────────
// cleanup
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Close all open sessions (polling stops with them). Swallows errors so
 * afterEach/afterAll never throws.
 */
export async function cleanup(
  ...accounts: (GossipSdk | undefined)[]
): Promise<void> {
  await Promise.allSettled(
    accounts.map(sdk => {
      if (sdk?.isSessionOpen) return sdk.closeSession();
    })
  );
}
