/**
 * MessageService unit tests
 *
 * Legacy tests that depended on removed DiscussionStatus and old callbacks were
 * removed. Their behavior is now covered by integration flows in:
 * - test/integration/messaging-flow.spec.ts
 * - test/integration/discussion-flow.spec.ts
 *
 * Here we only validate the public SDK wrapper for message lookup helpers.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GossipSdk } from '../../src/gossipSdk';
import {
  gossipDb,
  MessageStatus,
  MessageDirection,
  MessageType,
} from '../../src/db';
import { encodeUserId } from '../../src/utils/userId';
import { generateMnemonic } from '../../src/crypto/bip39';

const MESSAGE_OWNER_USER_ID = encodeUserId(new Uint8Array(32).fill(11));
const MESSAGE_CONTACT_USER_ID = encodeUserId(new Uint8Array(32).fill(12));

let sdk: GossipSdk;

describe('MessageService', () => {
  let db: GossipDatabase;

  beforeEach(async () => {
    db = gossipDb();
    if (!db.isOpen()) {
      await db.open();
    }
    await Promise.all(db.tables.map(table => table.clear()));

    sdk = new GossipSdk();
    await sdk.init();
    await sdk.openSession({ mnemonic: generateMnemonic() });
  });

  afterEach(async () => {
    if (sdk && sdk.isSessionOpen) {
      await sdk.closeSession();
    }
  });

  it('finds message by seeker', async () => {
    const seeker = new Uint8Array(32).fill(5);
    await db.messages.add({
      ownerUserId: MESSAGE_OWNER_USER_ID,
      contactUserId: MESSAGE_CONTACT_USER_ID,
      content: 'Hello',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date(),
      seeker,
    });

    const message = await sdk.messages.findBySeeker(
      seeker,
      MESSAGE_OWNER_USER_ID
    );

    expect(message).toBeDefined();
    expect(message?.content).toBe('Hello');
  });

  it('returns undefined for missing seeker', async () => {
    const seeker = new Uint8Array(32).fill(9);

    const message = await sdk.messages.findBySeeker(
      seeker,
      MESSAGE_OWNER_USER_ID
    );

    expect(message).toBeUndefined();
  });
});
