/**
 * Discussion e2e-style tests
 *
 * Uses real WASM SessionModule with real crypto.
 * MockMessageProtocol provides in-memory message storage (no network).
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  beforeAll,
} from 'vitest';
import {
  gossipDb,
  Contact,
  DiscussionDirection,
  MessageType,
  MessageDirection,
  MessageStatus,
  GossipDatabase,
} from '../../src/db';
import { MockMessageProtocol } from '../mocks';
import {
  createTestSession,
  cleanupTestSession,
  TestSessionData,
  setupSession,
} from '../utils';
import { encodeAnnouncementPayload } from '../../src/utils/announcementPayload';
import { GossipSdk } from '../../src/gossip';
import { ensureWasmInitialized } from '../../src/wasm/loader';
import { generateMnemonic } from '../../src/crypto/bip39';
import { generateEncryptionKey } from '../../src/wasm/encryption';
import {
  SessionStatus,
  SessionConfig,
} from '../../src/assets/generated/wasm/gossip_wasm';
import { UserPublicKeys } from '../../src/wasm/bindings';
import { AnnouncementService } from '../../src/services/announcement';
import { MessageService } from '../../src/services/message';

/**
 * Utility function to check if a session is fully up and active.
 * Verifies:
 * - Session status is Active
 * - Discussion weAccepted is true
 * - sendAnnouncement is null (no pending announcements)
 */
async function isLocalSessionUp(
  sdk: GossipSdk,
  contactUserId: string
): Promise<boolean> {
  const discussion = await sdk.discussions.get(sdk.userId, contactUserId);
  if (!discussion) return false;

  const status = sdk.discussions.getStatus(contactUserId);
  return (
    status === SessionStatus.Active &&
    discussion.weAccepted === true &&
    discussion.sendAnnouncement === null
  );
}

async function isSessionUp(
  aliceSdk: GossipSdk,
  bobSdk: GossipSdk
): Promise<boolean> {
  return (
    (await isLocalSessionUp(aliceSdk, bobSdk.userId)) &&
    (await isLocalSessionUp(bobSdk, aliceSdk.userId))
  );
}

describe('Discussion Flow', () => {
  let mockProtocol: MockMessageProtocol;
  let db: GossipDatabase;

  let alice: TestSessionData;
  let aliceSdk: GossipSdk;

  let bob: TestSessionData;
  let bobSdk: GossipSdk;

  beforeAll(async () => {
    await ensureWasmInitialized();
    mockProtocol = new MockMessageProtocol();
  });

  beforeEach(async () => {
    db = gossipDb();
    if (!db.isOpen()) {
      await db.open();
    }
    await Promise.all(db.tables.map(table => table.clear()));
    mockProtocol.clearMockData();

    vi.clearAllMocks();

    // Create real WASM sessions for Alice and Bob (for direct WASM operations)
    alice = await createTestSession(`alice-${Date.now()}-${Math.random()}`);
    bob = await createTestSession(`bob-${Date.now()}-${Math.random()}`);

    // Generate mnemonics for SDK sessions
    const aliceMnemonic = generateMnemonic();
    const bobMnemonic = generateMnemonic();
    const aliceEncryptionKey = await generateEncryptionKey();
    const bobEncryptionKey = await generateEncryptionKey();

    // Create gossipSdk instances for Alice and Bob
    aliceSdk = new GossipSdk();
    await aliceSdk.init();
    await aliceSdk.openSession({
      mnemonic: aliceMnemonic,
      encryptionKey: aliceEncryptionKey,
      onPersist: async () => {},
    });
    // Replace protocol with mock for testing
    (
      aliceSdk as unknown as { _announcement: AnnouncementService }
    )._announcement.setMessageProtocol(mockProtocol);
    (aliceSdk as unknown as { _message: MessageService })._message[
      'messageProtocol'
    ] = mockProtocol;

    bobSdk = new GossipSdk();
    await bobSdk.init();
    await bobSdk.openSession({
      mnemonic: bobMnemonic,
      encryptionKey: bobEncryptionKey,
      onPersist: async () => {},
    });
    // Replace protocol with mock for testing
    (
      bobSdk as unknown as { _announcement: AnnouncementService }
    )._announcement.setMessageProtocol(mockProtocol);
    (bobSdk as unknown as { _message: MessageService })._message[
      'messageProtocol'
    ] = mockProtocol;
  });

  afterEach(async () => {
    // Restore all mocks to their original implementations
    vi.restoreAllMocks();

    await aliceSdk.closeSession();
    await bobSdk.closeSession();
    cleanupTestSession(alice);
    cleanupTestSession(bob);
  });

  describe('Announcement Username Parsing', () => {
    it('Bob receives announcement with username and uses it as contact name', async () => {
      // Alice creates announcement with username in user_data
      const userData = encodeAnnouncementPayload(
        'Alice',
        'Hi, I would like to connect!'
      );
      if (!userData) {
        throw new Error('Expected announcement payload');
      }

      // Alice establishes outgoing session to Bob with user data
      const aliceAnnouncement = await alice.session.establishOutgoingSession(
        bobSdk.publicKeys,
        userData
      );

      // Store the announcement (simulates network)
      await mockProtocol.sendAnnouncement(aliceAnnouncement);

      // Bob fetches and processes announcements
      await bobSdk.announcements.fetch();

      // Bob should have Alice as a contact with the username from announcement
      const bobContact = await db.getContactByOwnerAndUserId(
        bobSdk.userId,
        alice.session.userIdEncoded
      );

      expect(bobContact).toBeDefined();
      expect(bobContact?.name).toBe('Alice');

      const bobDiscussion = await bobSdk.discussions.get(
        bobSdk.userId,
        alice.session.userIdEncoded
      );

      expect(bobDiscussion).toBeDefined();
      expect(bobDiscussion?.lastAnnouncementMessage).toBe(
        'Hi, I would like to connect!'
      );
    });

    it('Bob receives announcement without username (message only)', async () => {
      const userData = encodeAnnouncementPayload(
        undefined,
        'Hello without username'
      );
      if (!userData) {
        throw new Error('Expected announcement payload');
      }

      const aliceAnnouncement = await alice.session.establishOutgoingSession(
        bobSdk.publicKeys,
        userData
      );

      await mockProtocol.sendAnnouncement(aliceAnnouncement);
      await bobSdk.announcements.fetch();

      const bobContact = await db.getContactByOwnerAndUserId(
        bobSdk.userId,
        alice.session.userIdEncoded
      );

      expect(bobContact).toBeDefined();
      expect(bobContact?.name).toMatch(/^New Request \d+$/);

      const bobDiscussion = await bobSdk.discussions.get(
        bobSdk.userId,
        alice.session.userIdEncoded
      );

      expect(bobDiscussion?.lastAnnouncementMessage).toBe(
        'Hello without username'
      );
    });

    it('Bob receives announcement with username only (no message)', async () => {
      const userData = encodeAnnouncementPayload('AliceUser');
      if (!userData) {
        throw new Error('Expected announcement payload');
      }

      const aliceAnnouncement = await alice.session.establishOutgoingSession(
        bobSdk.publicKeys,
        userData
      );

      await mockProtocol.sendAnnouncement(aliceAnnouncement);
      await bobSdk.announcements.fetch();

      const bobContact = await db.getContactByOwnerAndUserId(
        bobSdk.userId,
        alice.session.userIdEncoded
      );

      expect(bobContact).toBeDefined();
      expect(bobContact?.name).toBe('AliceUser');

      const bobDiscussion = await bobSdk.discussions.get(
        bobSdk.userId,
        alice.session.userIdEncoded
      );

      expect(bobDiscussion?.lastAnnouncementMessage).toBeUndefined();
    });
  });

  describe('Discussion Initiation Happy Path', () => {
    it('Alice sends announcement and Bob accepts', async () => {
      // Alice adds Bob as a contact first
      const aliceBobContact: Omit<Contact, 'id'> = {
        ownerUserId: aliceSdk.userId,
        userId: bobSdk.userId,
        name: 'Bob',
        publicKeys: bobSdk.publicKeys.to_bytes(),
        avatar: undefined,
        isOnline: false,
        lastSeen: new Date(),
        createdAt: new Date(),
      };

      await db.contacts.add(aliceBobContact);

      // Alice initiates discussion with Bob
      const result = await aliceSdk.discussions.start(aliceBobContact);
      if (!result.success) throw result.error;
      const aliceDiscussionId = result.data.discussionId;

      const aliceDiscussion = await db.discussions.get(aliceDiscussionId);
      expect(aliceDiscussion).toBeDefined();
      expect(aliceDiscussion?.weAccepted).toBe(true);
      expect(aliceDiscussion?.direction).toBe(DiscussionDirection.INITIATED);
      expect(aliceDiscussion?.sendAnnouncement).toBeDefined();
      expect(aliceSdk.discussions.getStatus(bobSdk.userId)).toBe(
        SessionStatus.SelfRequested
      );

      // Bob fetches announcements and sees Alice's request
      await bobSdk.announcements.fetch();

      const bobDiscussion = await bobSdk.discussions.get(
        bobSdk.userId,
        aliceSdk.userId
      );

      expect(bobDiscussion).toBeDefined();
      expect(bobDiscussion?.weAccepted).toBe(false);
      expect(bobDiscussion?.direction).toBe(DiscussionDirection.RECEIVED);
      expect(bobSdk.discussions.getStatus(aliceSdk.userId)).toBe(
        SessionStatus.PeerRequested
      );

      if (!bobDiscussion) throw new Error('Bob discussion not found');

      // Bob accepts the discussion
      await bobSdk.discussions.accept(bobDiscussion);

      const bobDiscussionAfterAccept = await db.discussions.get(
        bobDiscussion.id!
      );
      expect(bobDiscussionAfterAccept?.weAccepted).toBe(true);
      expect(bobDiscussionAfterAccept?.sendAnnouncement).toBeDefined();
      expect(bobSdk.discussions.getStatus(aliceSdk.userId)).toBe(
        SessionStatus.Active
      );

      // Alice fetches announcements and sees Bob's acceptance
      await aliceSdk.announcements.fetch();

      // Verify both sides have active sessions
      expect(await isLocalSessionUp(aliceSdk, bobSdk.userId)).toBe(true);
      expect(await isLocalSessionUp(bobSdk, aliceSdk.userId)).toBe(true);
    });

    it('Both Alice and Bob send announcement at the same time', async () => {
      // Alice adds Bob as contact
      const aliceBobContact: Omit<Contact, 'id'> = {
        ownerUserId: aliceSdk.userId,
        userId: bobSdk.userId,
        name: 'Bob',
        publicKeys: bobSdk.publicKeys.to_bytes(),
        avatar: undefined,
        isOnline: false,
        lastSeen: new Date(),
        createdAt: new Date(),
      };

      await db.contacts.add(aliceBobContact);

      // Bob adds Alice as contact
      const bobAliceContact: Omit<Contact, 'id'> = {
        ownerUserId: bobSdk.userId,
        userId: aliceSdk.userId,
        name: 'Alice',
        publicKeys: aliceSdk.publicKeys.to_bytes(),
        avatar: undefined,
        isOnline: false,
        lastSeen: new Date(),
        createdAt: new Date(),
      };

      await db.contacts.add(bobAliceContact);

      // Both initiate at the same time
      const aliceResult = await aliceSdk.discussions.start(aliceBobContact, {
        username: undefined,
        message: 'Hello Bob!',
      });
      if (!aliceResult.success) {
        throw aliceResult.error;
      }
      const aliceDiscussionId = aliceResult.data.discussionId;

      const bobResult = await bobSdk.discussions.start(bobAliceContact, {
        username: undefined,
        message: 'Hello Alice!',
      });
      if (!bobResult.success) throw bobResult.error;
      const bobDiscussionId = bobResult.data.discussionId;

      const aliceDiscussion = await db.discussions.get(aliceDiscussionId);
      expect(aliceDiscussion?.weAccepted).toBe(true);
      expect(aliceDiscussion?.direction).toBe(DiscussionDirection.INITIATED);

      const bobDiscussion = await db.discussions.get(bobDiscussionId);
      expect(bobDiscussion?.weAccepted).toBe(true);
      expect(bobDiscussion?.direction).toBe(DiscussionDirection.INITIATED);

      // Alice fetches and sees Bob's announcement
      await aliceSdk.announcements.fetch();

      // Alice fetches and sees Bob's announcement
      await aliceSdk.announcements.fetch();

      // Bob fetches and sees Alice's announcement
      await bobSdk.announcements.fetch();

      // Verify both sides have active sessions
      expect(await isLocalSessionUp(aliceSdk, bobSdk.userId)).toBe(true);
      expect(await isLocalSessionUp(bobSdk, aliceSdk.userId)).toBe(true);
    });

    it('Alice send announcement but Bob refuse', async () => {
      // Alice adds Bob as a contact first
      const aliceBobContact: Omit<Contact, 'id'> = {
        ownerUserId: aliceSdk.userId,
        userId: bobSdk.userId,
        name: 'Bob',
        publicKeys: bobSdk.publicKeys.to_bytes(),
        avatar: undefined,
        isOnline: false,
        lastSeen: new Date(),
        createdAt: new Date(),
      };

      await db.contacts.add(aliceBobContact);

      // Alice initiates discussion with Bob
      const result = await aliceSdk.discussions.start(aliceBobContact);
      if (!result.success) throw result.error;
      const aliceDiscussionId = result.data.discussionId;

      const aliceDiscussion = await db.discussions.get(aliceDiscussionId);
      expect(aliceDiscussion).toBeDefined();
      expect(aliceDiscussion?.weAccepted).toBe(true);
      expect(aliceDiscussion?.direction).toBe(DiscussionDirection.INITIATED);
      expect(aliceSdk.discussions.getStatus(bobSdk.userId)).toBe(
        SessionStatus.SelfRequested
      );

      // Bob fetches announcements and sees Alice's request
      await bobSdk.announcements.fetch();

      const bobDiscussion = await bobSdk.discussions.get(
        bobSdk.userId,
        aliceSdk.userId
      );

      expect(bobDiscussion).toBeDefined();
      expect(bobDiscussion?.weAccepted).toBe(false);
      expect(bobDiscussion?.direction).toBe(DiscussionDirection.RECEIVED);
      expect(bobSdk.discussions.getStatus(aliceSdk.userId)).toBe(
        SessionStatus.PeerRequested
      );

      // Bob refuses by deleting the contact (which also deletes the discussion)
      await bobSdk.contacts.delete(bobSdk.userId, aliceSdk.userId);

      // On Bob's side: discussion and contact should be deleted
      const bobDiscussionAfterRefuse = await bobSdk.discussions.get(
        bobSdk.userId,
        aliceSdk.userId
      );
      expect(bobDiscussionAfterRefuse).toBeUndefined();

      const bobContactAfterRefuse = await db.getContactByOwnerAndUserId(
        bobSdk.userId,
        aliceSdk.userId
      );
      expect(bobContactAfterRefuse).toBeUndefined();

      // On Alice's side: discussion should remain pending
      const aliceDiscussionAfterRefuse =
        await db.discussions.get(aliceDiscussionId);
      expect(aliceDiscussionAfterRefuse).toBeDefined();
      expect(aliceDiscussionAfterRefuse?.weAccepted).toBe(true);
      expect(aliceDiscussionAfterRefuse?.direction).toBe(
        DiscussionDirection.INITIATED
      );
      expect(aliceSdk.discussions.getStatus(bobSdk.userId)).toBe(
        SessionStatus.SelfRequested
      );
    });

    it('Alice send announcement, bob refuse first then he init another announcement to Alice', async () => {
      // Alice adds Bob as a contact first
      const aliceBobContact: Omit<Contact, 'id'> = {
        ownerUserId: aliceSdk.userId,
        userId: bobSdk.userId,
        name: 'Bob',
        publicKeys: bobSdk.publicKeys.to_bytes(),
        avatar: undefined,
        isOnline: false,
        lastSeen: new Date(),
        createdAt: new Date(),
      };

      await db.contacts.add(aliceBobContact);

      // Alice initiates discussion with Bob
      const aliceResult = await aliceSdk.discussions.start(aliceBobContact);
      if (!aliceResult.success) throw aliceResult.error;

      // Bob fetches announcements and sees Alice's request
      await bobSdk.announcements.fetch();

      const bobDiscussion = await bobSdk.discussions.get(
        bobSdk.userId,
        aliceSdk.userId
      );
      expect(bobDiscussion).toBeDefined();

      // Bob refuses by deleting the contact
      await bobSdk.contacts.delete(bobSdk.userId, aliceSdk.userId);

      // Verify Bob's side is cleaned up
      const bobDiscussionAfterRefuse = await bobSdk.discussions.get(
        bobSdk.userId,
        aliceSdk.userId
      );
      expect(bobDiscussionAfterRefuse).toBeUndefined();

      // Bob adds Alice as a contact and initiates a new discussion
      const bobAliceContact: Omit<Contact, 'id'> = {
        ownerUserId: bobSdk.userId,
        userId: aliceSdk.userId,
        name: 'Alice',
        publicKeys: aliceSdk.publicKeys.to_bytes(),
        avatar: undefined,
        isOnline: false,
        lastSeen: new Date(),
        createdAt: new Date(),
      };

      await db.contacts.add(bobAliceContact);

      const bobResult = await bobSdk.discussions.start(bobAliceContact);
      if (!bobResult.success) throw bobResult.error;
      const bobDiscussionId = bobResult.data.discussionId;

      const bobNewDiscussion = await db.discussions.get(bobDiscussionId);
      expect(bobNewDiscussion).toBeDefined();
      expect(bobNewDiscussion?.weAccepted).toBe(true);
      expect(bobNewDiscussion?.direction).toBe(DiscussionDirection.INITIATED);
      expect(bobSdk.discussions.getStatus(aliceSdk.userId)).toBe(
        SessionStatus.SelfRequested
      );

      // Alice fetches announcements and sees Bob's new request
      // Note: Alice already has a discussion from when she initiated, so Bob's announcement
      // will update the existing discussion rather than create a new one
      await aliceSdk.announcements.fetch();

      const aliceDiscussionFromBob = await aliceSdk.discussions.get(
        aliceSdk.userId,
        bobSdk.userId
      );
      expect(aliceDiscussionFromBob).toBeDefined();
      // Alice's existing discussion is updated - she still has weAccepted: true from her initiation
      // When Bob starts after refusing, Alice receives the announcement which updates her existing discussion
      // Since both parties have now initiated, the session should become Active
      expect(aliceDiscussionFromBob?.weAccepted).toBe(true);
      expect(aliceDiscussionFromBob?.direction).toBe(
        DiscussionDirection.INITIATED
      );
      // When both parties send announcements, the session becomes Active
      expect(aliceSdk.discussions.getStatus(bobSdk.userId)).toBe(
        SessionStatus.Active
      );
    });

    it('Alice send announcement, Bob accept, then bob renew session', async () => {
      // Alice adds Bob as a contact first
      const aliceBobContact: Omit<Contact, 'id'> = {
        ownerUserId: aliceSdk.userId,
        userId: bobSdk.userId,
        name: 'Bob',
        publicKeys: bobSdk.publicKeys.to_bytes(),
        avatar: undefined,
        isOnline: false,
        lastSeen: new Date(),
        createdAt: new Date(),
      };

      await db.contacts.add(aliceBobContact);

      // Alice initiates discussion with Bob
      const result = await aliceSdk.discussions.start(aliceBobContact);
      if (!result.success) throw result.error;

      // Bob fetches announcements and sees Alice's request
      await bobSdk.announcements.fetch();

      const bobDiscussion = await bobSdk.discussions.get(
        bobSdk.userId,
        aliceSdk.userId
      );

      expect(bobDiscussion).toBeDefined();
      expect(bobDiscussion?.weAccepted).toBe(false);
      expect(bobSdk.discussions.getStatus(aliceSdk.userId)).toBe(
        SessionStatus.PeerRequested
      );

      if (!bobDiscussion) throw new Error('Bob discussion not found');

      // Bob accepts the discussion
      await bobSdk.discussions.accept(bobDiscussion);

      const bobDiscussionAfterAccept = await db.discussions.get(
        bobDiscussion.id!
      );
      expect(bobDiscussionAfterAccept?.weAccepted).toBe(true);
      expect(bobSdk.discussions.getStatus(aliceSdk.userId)).toBe(
        SessionStatus.Active
      );

      // Alice fetches announcements and sees Bob's acceptance
      await aliceSdk.announcements.fetch();

      // Verify both sides have active sessions before renewal
      expect(await isLocalSessionUp(aliceSdk, bobSdk.userId)).toBe(true);
      expect(await isLocalSessionUp(bobSdk, aliceSdk.userId)).toBe(true);

      // Bob renews the session
      const renewResult = await bobSdk.discussions.renew(aliceSdk.userId);
      expect(renewResult.success).toBe(true);
      if (!renewResult.success) throw renewResult.error;

      const bobDiscussionAfterRenew = await db.discussions.get(
        bobDiscussion.id!
      );
      expect(bobDiscussionAfterRenew?.sendAnnouncement).toBeDefined();
      expect(bobSdk.discussions.getStatus(aliceSdk.userId)).toBe(
        SessionStatus.Active
      );

      // Alice fetches announcements and sees Bob's renewal
      await aliceSdk.announcements.fetch();

      // Verify both sides have active sessions after renewal
      expect(await isLocalSessionUp(aliceSdk, bobSdk.userId)).toBe(true);
      expect(await isLocalSessionUp(bobSdk, aliceSdk.userId)).toBe(true);
    });

    it('Alice send announcement then renew, Bob accept after the renewal', async () => {
      // Alice adds Bob as a contact first
      const aliceBobContact: Omit<Contact, 'id'> = {
        ownerUserId: aliceSdk.userId,
        userId: bobSdk.userId,
        name: 'Bob',
        publicKeys: bobSdk.publicKeys.to_bytes(),
        avatar: undefined,
        isOnline: false,
        lastSeen: new Date(),
        createdAt: new Date(),
      };

      await db.contacts.add(aliceBobContact);

      const announcementMsg = 'Hello Bob!';
      // Alice sends initial announcement (starts discussion)
      const startResult = await aliceSdk.discussions.start(aliceBobContact, {
        username: 'Alice',
        message: announcementMsg,
      });
      if (!startResult.success) throw startResult.error;
      const aliceDiscussionId = startResult.data.discussionId;

      const aliceDiscussion = await db.discussions.get(aliceDiscussionId);
      expect(aliceDiscussion).toBeDefined();
      expect(aliceDiscussion?.weAccepted).toBe(true);
      expect(aliceDiscussion?.direction).toBe(DiscussionDirection.INITIATED);
      expect(aliceDiscussion?.sendAnnouncement).toBeDefined();
      expect(aliceSdk.discussions.getStatus(bobSdk.userId)).toBe(
        SessionStatus.SelfRequested
      );

      // Bob fetches announcements and sees Alice's initial request
      await bobSdk.announcements.fetch();

      let bobDiscussion = await bobSdk.discussions.get(
        bobSdk.userId,
        aliceSdk.userId
      );
      expect(bobDiscussion).toBeDefined();
      expect(bobDiscussion?.weAccepted).toBe(false);
      expect(bobDiscussion?.direction).toBe(DiscussionDirection.RECEIVED);
      expect(bobSdk.discussions.getStatus(aliceSdk.userId)).toBe(
        SessionStatus.PeerRequested
      );

      // Alice renews the session (sends a renewal announcement)
      const renewResult = await aliceSdk.discussions.renew(bobSdk.userId);
      expect(renewResult.success).toBe(true);
      if (!renewResult.success) throw renewResult.error;

      const aliceDiscussionAfterRenew =
        await db.discussions.get(aliceDiscussionId);
      expect(aliceDiscussionAfterRenew).toBeDefined();
      expect(aliceDiscussionAfterRenew?.weAccepted).toBe(true);
      expect(aliceDiscussionAfterRenew?.sendAnnouncement).toBeDefined();
      expect(aliceSdk.discussions.getStatus(bobSdk.userId)).toBe(
        SessionStatus.SelfRequested
      );

      // Bob fetches announcements and sees Alice's renewal
      await bobSdk.announcements.fetch();

      bobDiscussion = await bobSdk.discussions.get(
        bobSdk.userId,
        aliceSdk.userId
      );
      expect(bobDiscussion).toBeDefined();
      expect(bobDiscussion?.weAccepted).toBe(false);
      expect(bobDiscussion?.direction).toBe(DiscussionDirection.RECEIVED);
      expect(bobDiscussion?.lastAnnouncementMessage).toEqual(announcementMsg);
      expect(bobSdk.discussions.getStatus(aliceSdk.userId)).toBe(
        SessionStatus.PeerRequested
      );

      if (!bobDiscussion) throw new Error('Bob discussion not found');

      // Bob accepts the discussion after receiving the renewal
      await bobSdk.discussions.accept(bobDiscussion);

      const bobDiscussionAfterAccept = await db.discussions.get(
        bobDiscussion.id!
      );
      expect(bobDiscussionAfterAccept?.weAccepted).toBe(true);
      expect(bobDiscussionAfterAccept?.sendAnnouncement).toBeDefined();
      expect(bobSdk.discussions.getStatus(aliceSdk.userId)).toBe(
        SessionStatus.Active
      );

      // Alice fetches announcements and sees Bob's acceptance
      await aliceSdk.announcements.fetch();

      // Verify both sides have active sessions
      expect(await isLocalSessionUp(aliceSdk, bobSdk.userId)).toBe(true);
      expect(await isLocalSessionUp(bobSdk, aliceSdk.userId)).toBe(true);
    });
  });

  describe('Discussion Initiation Failures', () => {
    it('Alice signs announcement but network fails, then resend succeeds', async () => {
      const aliceBobContact: Omit<Contact, 'id'> = {
        ownerUserId: aliceSdk.userId,
        userId: bobSdk.userId,
        name: 'Bob',
        publicKeys: bobSdk.publicKeys.to_bytes(),
        avatar: undefined,
        isOnline: false,
        lastSeen: new Date(),
        createdAt: new Date(),
      };

      await db.contacts.add(aliceBobContact);

      // Set a short retry delay for this test
      // Since the service stores a reference to config, modifying it will update the service's config
      const originalRetryDelay = aliceSdk.config.announcements.retryDelayMs;
      aliceSdk.config.announcements.retryDelayMs = 100;

      // Make network fail on first attempt
      const originalSendAnnouncement =
        MockMessageProtocol.prototype.sendAnnouncement;
      let sendCallCount = 0;
      vi.spyOn(mockProtocol, 'sendAnnouncement').mockImplementation(
        async (announcement: Uint8Array) => {
          sendCallCount++;
          if (sendCallCount === 1) {
            // First call fails with network error
            throw new Error('Network error');
          }
          // Subsequent calls succeed - call the original implementation
          return originalSendAnnouncement.call(mockProtocol, announcement);
        }
      );

      const result = await aliceSdk.discussions.start(aliceBobContact);
      if (!result.success) throw result.error;
      const aliceDiscussionId = result.data.discussionId;

      let aliceDiscussion = await db.discussions.get(aliceDiscussionId);
      // After network failure, sendAnnouncement should still be set (ready to retry)
      expect(aliceDiscussion?.sendAnnouncement).not.toBeNull();

      await new Promise(resolve =>
        setTimeout(resolve, aliceSdk.config.announcements.retryDelayMs)
      );

      // Resend should succeed
      await expect(aliceSdk.updateState()).resolves.not.toThrow();

      aliceDiscussion = await db.discussions.get(aliceDiscussionId);

      // After resend, sendAnnouncement should be cleared if successful
      expect(aliceDiscussion?.sendAnnouncement).toBeNull();
      expect(aliceSdk.discussions.getStatus(bobSdk.userId)).toBe(
        SessionStatus.SelfRequested
      );

      // Restore original retry delay
      aliceSdk.config.announcements.retryDelayMs = originalRetryDelay;
    });

    it('Alice send announcement, bob accept but he get network failure. Then he resend and success', async () => {
      // PREPARATION
      // Set short retry delay for this test
      const originalRetryDelay = bobSdk.config.announcements.retryDelayMs;
      bobSdk.config.announcements.retryDelayMs = 100;

      // Set up spy to count calls - Alice's announcement (call 1) should succeed, Bob's (call 2) should fail
      const originalSendAnnouncement =
        MockMessageProtocol.prototype.sendAnnouncement;
      let callCount = 0;
      vi.spyOn(mockProtocol, 'sendAnnouncement').mockImplementation(
        async (announcement: Uint8Array) => {
          callCount++;
          // Bob's acceptance announcement (second call) should fail
          if (callCount === 2) {
            throw new Error('Network error');
          }
          // For other calls (Alice's announcement), call the original implementation
          return await originalSendAnnouncement.call(
            mockProtocol,
            announcement
          );
        }
      );

      // STEP 1: Alice initiates discussion with Bob (announcement succeeds - call 1)
      const aliceBobContact: Omit<Contact, 'id'> = {
        ownerUserId: aliceSdk.userId,
        userId: bobSdk.userId,
        name: 'Bob',
        publicKeys: bobSdk.publicKeys.to_bytes(),
        avatar: undefined,
        isOnline: false,
        lastSeen: new Date(),
        createdAt: new Date(),
      };

      await db.contacts.add(aliceBobContact);

      // Alice initiates discussion with Bob (announcement succeeds - call 1)
      const result = await aliceSdk.discussions.start(aliceBobContact);
      if (!result.success) throw result.error;

      // STEP 2: Bob fetches announcements and sees Alice's request
      await bobSdk.announcements.fetch();

      const bobDiscussion = await bobSdk.discussions.get(
        bobSdk.userId,
        aliceSdk.userId
      );
      expect(bobDiscussion).toBeDefined();
      expect(bobDiscussion?.weAccepted).toBe(false);

      if (!bobDiscussion) throw new Error('Bob discussion not found');

      // STEP 3: Bob accepts but network fails
      await bobSdk.discussions.accept(bobDiscussion);

      let bobDiscussionAfterAccept = await db.discussions.get(
        bobDiscussion.id!
      );
      expect(bobDiscussionAfterAccept?.weAccepted).toBe(true);
      expect(bobDiscussionAfterAccept?.sendAnnouncement).not.toBeNull();

      // Wait for retry delay
      await new Promise(resolve =>
        setTimeout(resolve, bobSdk.config.announcements.retryDelayMs + 50)
      );

      // STEP 4: Bob resends and succeeds
      await expect(bobSdk.updateState()).resolves.not.toThrow();

      bobDiscussionAfterAccept = await db.discussions.get(bobDiscussion.id!);
      expect(bobDiscussionAfterAccept?.sendAnnouncement).toBeNull();

      // STEP 5: Alice fetches announcements and sees Bob's acceptance
      await aliceSdk.announcements.fetch();

      // Verify both sides have active sessions
      expect(await isLocalSessionUp(aliceSdk, bobSdk.userId)).toBe(true);
      expect(await isLocalSessionUp(bobSdk, aliceSdk.userId)).toBe(true);

      // Restore original retry delay
      bobSdk.config.announcements.retryDelayMs = originalRetryDelay;
    });

    it('Alice send announcement but network fails, she receive announcement from bob before resending', async () => {
      // PREPARATION
      // Set short retry delay for this test
      const originalRetryDelay = aliceSdk.config.announcements.retryDelayMs;
      aliceSdk.config.announcements.retryDelayMs = 100;

      // Make network fail when Alice tries to send announcement
      const originalSendAnnouncement =
        MockMessageProtocol.prototype.sendAnnouncement;
      let sendCallCount = 0;
      vi.spyOn(mockProtocol, 'sendAnnouncement').mockImplementation(
        async (announcement: Uint8Array) => {
          sendCallCount++;
          if (sendCallCount === 1) {
            // First call (Alice) fails with network error
            throw new Error('Network error');
          }
          // Subsequent calls (Bob and retries) succeed - call the original implementation
          return originalSendAnnouncement.call(mockProtocol, announcement);
        }
      );

      // STEP 1: Alice initiates discussion but network fails
      const aliceBobContact: Omit<Contact, 'id'> = {
        ownerUserId: aliceSdk.userId,
        userId: bobSdk.userId,
        name: 'Bob',
        publicKeys: bobSdk.publicKeys.to_bytes(),
        avatar: undefined,
        isOnline: false,
        lastSeen: new Date(),
        createdAt: new Date(),
      };

      await db.contacts.add(aliceBobContact);

      // Alice initiates discussion but network fails
      const result = await aliceSdk.discussions.start(aliceBobContact);
      if (!result.success) throw result.error;
      const aliceDiscussionId = result.data.discussionId;

      let aliceDiscussion = await db.discussions.get(aliceDiscussionId);
      expect(aliceDiscussion?.sendAnnouncement).not.toBeNull();

      // STEP 2: Bob adds Alice as contact and initiates discussion
      const bobAliceContact: Omit<Contact, 'id'> = {
        ownerUserId: bobSdk.userId,
        userId: aliceSdk.userId,
        name: 'Alice',
        publicKeys: aliceSdk.publicKeys.to_bytes(),
        avatar: undefined,
        isOnline: false,
        lastSeen: new Date(),
        createdAt: new Date(),
      };

      await db.contacts.add(bobAliceContact);
      await bobSdk.discussions.start(bobAliceContact);

      // STEP 3: Alice receives Bob's announcement before resending her own
      const res = await aliceSdk.announcements.fetch();
      expect(res.success).toBe(true);

      aliceDiscussion = await db.discussions.get(aliceDiscussionId);
      // When Alice receives Bob's announcement, the session should become Active
      // But sendAnnouncement is still not null (pending retry of Alice's failed announcement)
      expect(aliceDiscussion?.weAccepted).toBe(true);
      expect(aliceDiscussion?.sendAnnouncement).not.toBeNull();
      expect(aliceSdk.discussions.getStatus(bobSdk.userId)).toBe(
        SessionStatus.Active
      );

      // STEP 4: Alice resends and succeeds
      // Wait for retry delay
      await new Promise(resolve =>
        setTimeout(resolve, aliceSdk.config.announcements.retryDelayMs + 50)
      );

      await expect(aliceSdk.updateState()).resolves.not.toThrow();

      aliceDiscussion = await db.discussions.get(aliceDiscussionId);
      expect(aliceDiscussion?.sendAnnouncement).toBeNull();

      // STEP 5: Bob fetches and sees Alice's announcement
      const bobFetchResult = await bobSdk.announcements.fetch();
      expect(bobFetchResult.success).toBe(true);

      // Verify both sides have active sessions
      expect(await isSessionUp(aliceSdk, bobSdk)).toBe(true);

      // Restore original retry delay
      aliceSdk.config.announcements.retryDelayMs = originalRetryDelay;
    });

    it('Alice init discussion but get error while signing announcement. Retry and get network error. Retry 2nd time and success', async () => {
      // PREPARATION

      // Set short retry delay for this test
      const originalRetryDelay = aliceSdk.config.announcements.retryDelayMs;
      aliceSdk.config.announcements.retryDelayMs = 100;

      // Mock establishSession to fail on first call (simulating signing error)
      // But we need to handle the case where the discussion might be deleted
      const announcementService = (
        aliceSdk as unknown as { _announcement: AnnouncementService }
      )._announcement;
      const originalEstablishSession =
        announcementService.establishSession.bind(announcementService);
      let establishCallCount = 0;
      vi.spyOn(announcementService, 'establishSession').mockImplementation(
        async (contactPublicKeys: UserPublicKeys, userData?: Uint8Array) => {
          establishCallCount++;
          if (establishCallCount === 1) {
            return { success: false, error: new Error('Signing error') };
          }
          return originalEstablishSession(contactPublicKeys, userData);
        }
      );

      // Make network fail on first attempt (this happens after establishSession succeeds on retry)
      let sendCallCount = 0;
      // Store the original implementation before spying
      const originalSendAnnouncementImpl =
        MockMessageProtocol.prototype.sendAnnouncement;
      vi.spyOn(mockProtocol, 'sendAnnouncement').mockImplementation(
        async (announcement: Uint8Array) => {
          sendCallCount++;
          if (sendCallCount === 1) {
            throw new Error('Network error');
          }
          // For subsequent calls, call the original implementation
          return await originalSendAnnouncementImpl.call(
            mockProtocol,
            announcement
          );
        }
      );

      // STEP 1: Alice tries to start discussion but gets signing error on first attempt
      const aliceBobContact: Omit<Contact, 'id'> = {
        ownerUserId: aliceSdk.userId,
        userId: bobSdk.userId,
        name: 'Bob',
        publicKeys: bobSdk.publicKeys.to_bytes(),
        avatar: undefined,
        isOnline: false,
        lastSeen: new Date(),
        createdAt: new Date(),
      };

      await db.contacts.add(aliceBobContact);

      let result = await aliceSdk.discussions.start(aliceBobContact);
      expect(result.success).toBe(false);
      expect(
        await aliceSdk.discussions.get(aliceSdk.userId, bobSdk.userId)
      ).toBeUndefined();

      // STEP 2: Retry start (establishSession will work now) but network error
      result = await aliceSdk.discussions.start(aliceBobContact);
      if (!result.success) throw result.error;
      const aliceDiscussionId = result.data.discussionId;

      let aliceDiscussion = await db.discussions.get(aliceDiscussionId);
      // After network failure, sendAnnouncement should be set for retry
      expect(aliceDiscussion?.sendAnnouncement).not.toBeNull();

      // STEP 3: retry send on network should succeed
      // Wait for retry delay
      await new Promise(resolve =>
        setTimeout(resolve, aliceSdk.config.announcements.retryDelayMs + 50)
      );

      await expect(aliceSdk.updateState()).resolves.not.toThrow();

      aliceDiscussion = await db.discussions.get(aliceDiscussionId);
      expect(aliceDiscussion?.sendAnnouncement).toBeNull();
      expect(aliceSdk.discussions.getStatus(bobSdk.userId)).toBe(
        SessionStatus.SelfRequested
      );

      // Restore original retry delay
      aliceSdk.config.announcements.retryDelayMs = originalRetryDelay;
    });

    it('Bob receive announcement from alice. He accept but get error while signing. Network issue on 2nd attempt. Success on 3rd attempt', async () => {
      // STEP 1: Alice initiates discussion with Bob
      const aliceBobContact: Omit<Contact, 'id'> = {
        ownerUserId: aliceSdk.userId,
        userId: bobSdk.userId,
        name: 'Bob',
        publicKeys: bobSdk.publicKeys.to_bytes(),
        avatar: undefined,
        isOnline: false,
        lastSeen: new Date(),
        createdAt: new Date(),
      };

      await db.contacts.add(aliceBobContact);

      // Set short retry delay for this test
      const originalRetryDelay = bobSdk.config.announcements.retryDelayMs;
      bobSdk.config.announcements.retryDelayMs = 100;

      // Alice initiates discussion with Bob
      const result = await aliceSdk.discussions.start(aliceBobContact);
      if (!result.success) throw result.error;

      // STEP 2: Bob fetches announcements and sees Alice's request
      const res = await bobSdk.announcements.fetch();
      expect(res.success).toBe(true);

      const bobDiscussion = await bobSdk.discussions.get(
        bobSdk.userId,
        aliceSdk.userId
      );
      if (!bobDiscussion) throw new Error('Bob discussion not found');

      expect(bobDiscussion.weAccepted).toBe(false);
      expect(bobDiscussion.sendAnnouncement).toBeNull();
      expect(bobSdk.discussions.getStatus(aliceSdk.userId)).toBe(
        SessionStatus.PeerRequested
      );

      // STEP 3: Bob accepts but gets signing error on first attempt
      // Mock establishSession to fail on first call (simulating signing error)
      const bobAnnouncementService = (
        bobSdk as unknown as { _announcement: AnnouncementService }
      )._announcement;
      const originalEstablishSession =
        bobAnnouncementService.establishSession.bind(bobAnnouncementService);
      let establishCallCount = 0;
      vi.spyOn(bobAnnouncementService, 'establishSession').mockImplementation(
        async (contactPublicKeys: UserPublicKeys, userData?: Uint8Array) => {
          establishCallCount++;
          if (establishCallCount === 1) {
            throw new Error('Signing error');
          }
          return originalEstablishSession(contactPublicKeys, userData);
        }
      );

      // Make network fail on first attempt (after establishSession succeeds on retry)
      const originalSendAnnouncement =
        MockMessageProtocol.prototype.sendAnnouncement;
      let sendCallCount = 0;
      vi.spyOn(mockProtocol, 'sendAnnouncement').mockImplementation(
        async (announcement: Uint8Array) => {
          sendCallCount++;
          if (sendCallCount === 1) {
            throw new Error('Network error');
          }
          // For subsequent calls, call the original implementation
          return await originalSendAnnouncement.call(
            mockProtocol,
            announcement
          );
        }
      );

      // Bob accepts but gets signing error on first attempt
      const res1 = await bobSdk.discussions.accept(bobDiscussion);
      const bobDiscussionSignError = await bobSdk.discussions.get(
        bobSdk.userId,
        aliceSdk.userId
      );
      expect(res1.success).toBe(false);
      expect(bobSdk.discussions.getStatus(aliceSdk.userId)).toBe(
        SessionStatus.PeerRequested
      );
      // When signing fails, no announcement is created, so sendAnnouncement should be null
      expect(bobDiscussionSignError?.sendAnnouncement).toBeNull();
      expect(bobDiscussionSignError?.weAccepted).toBe(false);

      // STEP 4: Retry accept (establishSession will work now) but network issue on 2nd attempt
      const res2 = await bobSdk.discussions.accept(bobDiscussion);
      expect(res2.success).toBe(true);
      const bobDiscussionAfterAccept = await bobSdk.discussions.get(
        bobSdk.userId,
        aliceSdk.userId
      );
      expect(bobSdk.discussions.getStatus(aliceSdk.userId)).toBe(
        SessionStatus.Active
      );
      expect(bobDiscussionAfterAccept?.sendAnnouncement).not.toBeNull();
      expect(bobDiscussionAfterAccept?.weAccepted).toBe(true);

      // STEP 5: Retry send on network should succeed
      // Wait for retry delay
      await new Promise(resolve =>
        setTimeout(resolve, bobSdk.config.announcements.retryDelayMs + 50)
      );

      // Retry should succeed
      await expect(bobSdk.updateState()).resolves.not.toThrow();

      expect(await isLocalSessionUp(bobSdk, aliceSdk.userId)).toBe(true);

      // STEP 6: Alice fetches announcements and sees Bob's acceptance
      const fetchResult = await aliceSdk.announcements.fetch();
      expect(fetchResult.success).toBe(true);

      // Verify session states
      expect(await isSessionUp(aliceSdk, bobSdk)).toBe(true);

      // Restore original retry delay
      bobSdk.config.announcements.retryDelayMs = originalRetryDelay;
    });
  });

  describe('remove contact', () => {
    /**
     * Helper function to verify that contact deletion was successful
     */
    async function checkDeleted(
      userSdk: GossipSdk,
      contactUserId: string,
      database: typeof db
    ): Promise<void> {
      // Verify contact is deleted
      const contact = await database.getContactByOwnerAndUserId(
        userSdk.userId,
        contactUserId
      );
      expect(contact).toBeUndefined();

      // Verify discussion is deleted
      const discussion = await userSdk.discussions.get(
        userSdk.userId,
        contactUserId
      );
      expect(discussion).toBeUndefined();

      // Verify all messages are deleted
      const messages = await database.messages
        .where('[ownerUserId+contactUserId]')
        .equals([userSdk.userId, contactUserId])
        .toArray();
      expect(messages.length).toBe(0);

      // Verify session status is UnknownPeer
      expect(userSdk.discussions.getStatus(contactUserId)).toBe(
        SessionStatus.UnknownPeer
      );
    }

    it('Alice delete Bob contact', async () => {
      // Setup: Alice and Bob establish a session
      await setupSession(aliceSdk, bobSdk, 'Bob', 'Alice');

      // Verify session is active
      expect(await isLocalSessionUp(aliceSdk, bobSdk.userId)).toBe(true);

      // Alice deletes Bob contact
      await aliceSdk.contacts.delete(aliceSdk.userId, bobSdk.userId);

      // Verify deletion was successful
      await checkDeleted(aliceSdk, bobSdk.userId, db);
    });

    it('Alice send an announcement with msg to bob but bob delete alice contact', async () => {
      const aliceBobContact: Omit<Contact, 'id'> = {
        ownerUserId: aliceSdk.userId,
        userId: bobSdk.userId,
        name: 'Bob',
        publicKeys: bobSdk.publicKeys.to_bytes(),
        avatar: undefined,
        isOnline: false,
        lastSeen: new Date(),
        createdAt: new Date(),
      };

      await db.contacts.add(aliceBobContact);

      // Alice sends announcement with message
      const announcementMsg = "Hello Bob, let's connect!";
      const result = await aliceSdk.discussions.start(aliceBobContact, {
        username: 'Alice',
        message: announcementMsg,
      });
      if (!result.success) throw result.error;

      // Bob fetches Alice's announcement
      await bobSdk.announcements.fetch();

      // Verify Bob has Alice's contact
      const bobAliceContact = await db.getContactByOwnerAndUserId(
        bobSdk.userId,
        aliceSdk.userId
      );
      expect(bobAliceContact).toBeDefined();

      // Verify Bob has discussion with Alice
      const bobDiscussion = await bobSdk.discussions.get(
        bobSdk.userId,
        aliceSdk.userId
      );
      expect(bobDiscussion).toBeDefined();
      expect(bobDiscussion?.lastAnnouncementMessage).toBe(announcementMsg);
      expect(bobDiscussion?.weAccepted).toBe(false);

      // Bob deletes Alice's contact
      await bobSdk.contacts.delete(bobSdk.userId, aliceSdk.userId);

      // Verify deletion was successful
      await checkDeleted(bobSdk, aliceSdk.userId, db);

      // Verify Alice has still a pending discussion with Bob
      const aliceDiscussion = await aliceSdk.discussions.get(
        aliceSdk.userId,
        bobSdk.userId
      );
      expect(aliceDiscussion).toBeDefined();
      // Alice initiated the discussion, so weAccepted stays true but the session is still pending on Bob's side
      expect(aliceDiscussion?.weAccepted).toBe(true);
      expect(aliceDiscussion?.direction).toBe(DiscussionDirection.INITIATED);
      expect(aliceSdk.discussions.getStatus(bobSdk.userId)).toBe(
        SessionStatus.SelfRequested
      );
    });

    it('Alice Send announcement to Bob. Alice delete Bob before he accept', async () => {
      const aliceBobContact: Omit<Contact, 'id'> = {
        ownerUserId: aliceSdk.userId,
        userId: bobSdk.userId,
        name: 'Bob',
        publicKeys: bobSdk.publicKeys.to_bytes(),
        avatar: undefined,
        isOnline: false,
        lastSeen: new Date(),
        createdAt: new Date(),
      };

      await db.contacts.add(aliceBobContact);

      // Alice sends announcement with message
      const announcementMsg = 'Hello Bob!';
      const result = await aliceSdk.discussions.start(aliceBobContact, {
        username: 'Alice',
        message: announcementMsg,
      });
      if (!result.success) throw result.error;

      // Bob fetches Alice's announcement
      await bobSdk.announcements.fetch();

      const bobDiscussion = await bobSdk.discussions.get(
        bobSdk.userId,
        aliceSdk.userId
      );
      expect(bobDiscussion).toBeDefined();
      expect(bobDiscussion?.weAccepted).toBe(false);

      // Alice deletes Bob's contact before he accepts
      await aliceSdk.contacts.delete(aliceSdk.userId, bobSdk.userId);

      // Verify deletion was successful
      await checkDeleted(aliceSdk, bobSdk.userId, db);

      // Bob accepts and sends announcement back
      if (!bobDiscussion) throw new Error('Bob discussion not found');
      await bobSdk.discussions.accept(bobDiscussion);

      // Alice fetches Bob's announcement
      await aliceSdk.announcements.fetch();

      // Alice should see Bob's announcement as PeerRequested with weAccepted=false
      const aliceDiscussionFromBob = await aliceSdk.discussions.get(
        aliceSdk.userId,
        bobSdk.userId
      );
      expect(aliceDiscussionFromBob).toBeDefined();
      expect(aliceDiscussionFromBob?.weAccepted).toBe(false);
      expect(aliceDiscussionFromBob?.direction).toBe(
        DiscussionDirection.RECEIVED
      );
      expect(aliceSdk.discussions.getStatus(bobSdk.userId)).toBe(
        SessionStatus.PeerRequested
      );

      // Alice accepts
      if (!aliceDiscussionFromBob)
        throw new Error('Alice discussion not found');
      await aliceSdk.discussions.accept(aliceDiscussionFromBob);

      // Bob fetches Alice's acceptance
      await bobSdk.announcements.fetch();

      // Verify both sides have active sessions
      expect(await isSessionUp(aliceSdk, bobSdk)).toBe(true);
    });

    it('When delete contact, all msg status are deleted: waiting_session, ready, sent and acknowledge', async () => {
      // Setup: Alice and Bob establish a session
      await setupSession(aliceSdk, bobSdk, 'Bob', 'Alice');

      // Create messages with different statuses
      // 1. Incoming message
      await bobSdk.messages.send({
        ownerUserId: bobSdk.userId,
        contactUserId: aliceSdk.userId,
        content: 'Bob message',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.WAITING_SESSION,
        timestamp: new Date(),
      });
      await aliceSdk.messages.fetch();

      // 2. Outgoing WAITING_SESSION
      await db.messages.add({
        ownerUserId: aliceSdk.userId,
        contactUserId: bobSdk.userId,
        content: 'Message WAITING_SESSION',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.WAITING_SESSION,
        timestamp: new Date(),
      });

      // 3. Outgoing READY
      await db.messages.add({
        ownerUserId: aliceSdk.userId,
        contactUserId: bobSdk.userId,
        content: 'Message READY',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.READY,
        timestamp: new Date(),
        seeker: new Uint8Array([1, 2, 3]),
        encryptedMessage: new Uint8Array([4, 5, 6]),
        whenToSend: new Date(Date.now() + 1000),
      });

      // 4. Outgoing SENT
      await db.messages.add({
        ownerUserId: aliceSdk.userId,
        contactUserId: bobSdk.userId,
        content: 'Message SENT',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENT,
        timestamp: new Date(),
        seeker: new Uint8Array([7, 8, 9]),
        encryptedMessage: new Uint8Array([10, 11, 12]),
        whenToSend: new Date(),
      });

      // 5. Outgoing DELIVERED (acknowledged)
      await db.messages.add({
        ownerUserId: aliceSdk.userId,
        contactUserId: bobSdk.userId,
        content: 'Message DELIVERED',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.DELIVERED,
        timestamp: new Date(),
        seeker: new Uint8Array([13, 14, 15]),
      });

      // Alice deletes Bob's contact
      await aliceSdk.contacts.delete(aliceSdk.userId, bobSdk.userId);

      // Verify deletion was successful
      await checkDeleted(aliceSdk, bobSdk.userId, db);
    });

    it("Alice delete bob contact, Bob send msg to alice, she fetch messages but don't receive it", async () => {
      // Setup: Alice and Bob establish a session
      await setupSession(aliceSdk, bobSdk, 'Bob', 'Alice');

      // Verify session is active
      expect(await isSessionUp(aliceSdk, bobSdk)).toBe(true);

      // Alice deletes Bob's contact
      await aliceSdk.contacts.delete(aliceSdk.userId, bobSdk.userId);

      // Verify deletion was successful
      await checkDeleted(aliceSdk, bobSdk.userId, db);

      // Bob sends a message to Alice
      const bobMsgResult = await bobSdk.messages.send({
        ownerUserId: bobSdk.userId,
        contactUserId: aliceSdk.userId,
        content: 'Hello Alice after deletion!',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.WAITING_SESSION,
        timestamp: new Date(),
      });
      expect(bobMsgResult.success).toBe(true);

      // Alice fetches messages
      const fetchResult = await aliceSdk.messages.fetch();
      expect(fetchResult.success).toBe(true);

      // Verify Alice still has no messages (deletion should persist)
      const aliceMessages = await db.messages
        .where('[ownerUserId+contactUserId]')
        .equals([aliceSdk.userId, bobSdk.userId])
        .toArray();
      expect(aliceMessages.length).toBe(0);

      // Verify Bob's message is still sent but won't be delivered
      const bobMessages = await db.messages
        .where('[ownerUserId+contactUserId]')
        .equals([bobSdk.userId, aliceSdk.userId])
        .toArray();
      const bobOutgoingMsg = bobMessages.find(
        m => m.content === 'Hello Alice after deletion!'
      );
      expect(bobOutgoingMsg).toBeDefined();
      expect(bobOutgoingMsg?.status).toBe(MessageStatus.SENT);
      expect(bobOutgoingMsg?.seeker).toBeDefined();
    });
  });
});

describe('session break in session manager', () => {
  let mockProtocol: MockMessageProtocol;

  let aliceSdk: GossipSdk;
  let bobSdk: GossipSdk;

  beforeAll(async () => {
    await ensureWasmInitialized();
    mockProtocol = new MockMessageProtocol();
  });

  beforeEach(async () => {
    aliceSdk = new GossipSdk();
    await aliceSdk.init();
    bobSdk = new GossipSdk();
    await bobSdk.init();
    mockProtocol.clearMockData();
  });

  afterEach(async () => {
    await aliceSdk.closeSession();
    await bobSdk.closeSession();
  });

  // Helper function to create a SessionConfig (each SDK needs its own instance)
  function createSessionConfig(
    max_session_inactivity_millis: number,
    keep_alive_interval_millis: number,
    max_session_lag_length: bigint = 10000n
  ): SessionConfig {
    return new SessionConfig(
      7 * 24 * 60 * 60 * 1000, // max_incoming_announcement_age_millis: 1 week
      60 * 1000, // max_incoming_announcement_future_millis: 1 minute
      7 * 24 * 60 * 60 * 1000, // max_incoming_message_age_millis: 1 week
      60 * 1000, // max_incoming_message_future_millis: 1 minute
      max_session_inactivity_millis,
      keep_alive_interval_millis,
      max_session_lag_length
    );
  }

  // Helper function to create custom SDKs with specific SessionConfig
  async function createCustomSdks(
    max_session_inactivity_millis: number,
    keep_alive_interval_millis: number,
    max_session_lag_length: bigint = 10000n
  ): Promise<void> {
    const aliceMnemonic = generateMnemonic();
    const bobMnemonic = generateMnemonic();
    const aliceEncryptionKey = await generateEncryptionKey();
    const bobEncryptionKey = await generateEncryptionKey();

    aliceSdk = new GossipSdk();
    await aliceSdk.init();
    await aliceSdk.openSession({
      mnemonic: aliceMnemonic,
      encryptionKey: aliceEncryptionKey,
      onPersist: async () => {},
      sessionConfig: createSessionConfig(
        max_session_inactivity_millis,
        keep_alive_interval_millis,
        max_session_lag_length
      ),
    });
    (
      aliceSdk as unknown as { _announcement: AnnouncementService }
    )._announcement.setMessageProtocol(mockProtocol);
    (aliceSdk as unknown as { _message: MessageService })._message[
      'messageProtocol'
    ] = mockProtocol;

    bobSdk = new GossipSdk();
    await bobSdk.init();
    await bobSdk.openSession({
      mnemonic: bobMnemonic,
      encryptionKey: bobEncryptionKey,
      onPersist: async () => {},
      sessionConfig: createSessionConfig(
        max_session_inactivity_millis,
        keep_alive_interval_millis,
        max_session_lag_length
      ),
    });
    (
      bobSdk as unknown as { _announcement: AnnouncementService }
    )._announcement.setMessageProtocol(mockProtocol);
    (bobSdk as unknown as { _message: MessageService })._message[
      'messageProtocol'
    ] = mockProtocol;
  }

  it('Alice has not received incoming msg for too long, session is killed and reset by updateState function (no msg)', async () => {
    await createCustomSdks(
      2000, // max_session_inactivity_millis: 2 seconds
      10000 // keep_alive_interval_millis: 10 seconds
    );

    // Setup: Alice and Bob establish a session
    await setupSession(aliceSdk, bobSdk, 'Bob', 'Alice');

    // Verify session is active
    expect(await isLocalSessionUp(aliceSdk, bobSdk.userId)).toBe(true);

    // Spy on establishSession to verify it's called during reset
    const aliceAnnouncementService = (
      aliceSdk as unknown as { _announcement: AnnouncementService }
    )._announcement;
    const establishSpy = vi.spyOn(aliceAnnouncementService, 'establishSession');

    // Wait for max_session_inactivity_millis (2000ms) + buffer
    await new Promise(resolve => setTimeout(resolve, 2100));

    // Call updateState - this should trigger session reset
    await aliceSdk.updateState();

    // Verify establishSession was called (session was renewed)
    expect(establishSpy).toHaveBeenCalled();

    // Session should still be active after reset
    expect(aliceSdk.discussions.getStatus(bobSdk.userId)).toBe(
      SessionStatus.Active
    );

    establishSpy.mockRestore();
  });

  it('Alice has not received incoming msg for too long, session is killed and reset by updateState function (with msg)', async () => {
    await createCustomSdks(
      2000, // max_session_inactivity_millis: 2 seconds
      10000 // keep_alive_interval_millis: 10 seconds
    );

    // Setup: Alice and Bob establish a session
    await setupSession(aliceSdk, bobSdk, 'Bob', 'Alice', "hi it's alice");

    // Verify session is active
    expect(await isLocalSessionUp(aliceSdk, bobSdk.userId)).toBe(true);

    // Spy on protocol announcements after initial session setup
    const sendAnnouncementSpy = vi.spyOn(mockProtocol, 'sendAnnouncement');

    // 1. Bob sends one incoming message to Alice
    const bobMsgResult = await bobSdk.messages.send({
      ownerUserId: bobSdk.userId,
      contactUserId: aliceSdk.userId,
      content: 'Incoming from Bob',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.WAITING_SESSION,
      timestamp: new Date(),
    });
    expect(bobMsgResult.success).toBe(true);

    await aliceSdk.messages.fetch();

    const aliceIncomingMessagesBefore = await aliceSdk.db.messages
      .where('[ownerUserId+contactUserId+direction]')
      .equals([aliceSdk.userId, bobSdk.userId, MessageDirection.INCOMING])
      .toArray();
    expect(aliceIncomingMessagesBefore.length).toBe(1);
    expect(aliceIncomingMessagesBefore[0].status).toBe(MessageStatus.DELIVERED);
    expect(aliceIncomingMessagesBefore[0].seeker).toBeUndefined();

    // 2. Create 4 outgoing messages for Alice with different statuses
    // WAITING_SESSION
    await aliceSdk.db.messages.add({
      ownerUserId: aliceSdk.userId,
      contactUserId: bobSdk.userId,
      messageId: new Uint8Array(12).fill(1),
      content: 'Message WAITING_SESSION',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.WAITING_SESSION,
      timestamp: new Date(),
    });

    // READY
    await aliceSdk.db.messages.add({
      ownerUserId: aliceSdk.userId,
      contactUserId: bobSdk.userId,
      messageId: new Uint8Array(12).fill(2),
      content: 'Message READY',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.READY,
      timestamp: new Date(),
      seeker: new Uint8Array([1, 2, 3]),
      encryptedMessage: new Uint8Array([4, 5, 6]),
      whenToSend: new Date(),
    });

    // SENT
    await aliceSdk.db.messages.add({
      ownerUserId: aliceSdk.userId,
      contactUserId: bobSdk.userId,
      messageId: new Uint8Array(12).fill(3),
      content: 'Message SENT',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date(),
      seeker: new Uint8Array([7, 8, 9]),
      encryptedMessage: new Uint8Array([10, 11, 12]),
      whenToSend: new Date(),
    });

    // DELIVERED (acknowledged)
    await aliceSdk.db.messages.add({
      ownerUserId: aliceSdk.userId,
      contactUserId: bobSdk.userId,
      messageId: new Uint8Array(12).fill(4),
      content: 'Message DELIVERED',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.DELIVERED,
      timestamp: new Date(),
      seeker: new Uint8Array([13, 14, 15]),
    });

    const aliceOutgoingBefore = await aliceSdk.db.messages
      .where('[ownerUserId+contactUserId+direction]')
      .equals([aliceSdk.userId, bobSdk.userId, MessageDirection.OUTGOING])
      .toArray();
    expect(aliceOutgoingBefore.length).toBe(5);

    // Spy on message send to verify it's called
    const sendMessageSpy = vi.spyOn(mockProtocol, 'sendMessage');

    // 4. Wait for inactivity to kill the session
    await new Promise(resolve => setTimeout(resolve, 2100));

    // 5. Call updateState - this should reset the session
    await aliceSdk.updateState();

    // A new session should be created (announcement sent once for reset)
    expect(sendAnnouncementSpy).toHaveBeenCalledTimes(1);

    // Verify message send to verify it's called
    expect(sendMessageSpy).toHaveBeenCalledTimes(3); // 3 messages are sent: 1 for the WAITING_SESSION message, 1 for the READY message, 1 for the SENT message

    // Session should still be active after reset
    expect(aliceSdk.discussions.getStatus(bobSdk.userId)).toBe(
      SessionStatus.Active
    );

    // Outgoing DELIVERED message should not be resent or reset
    const aliceOutgoingAfter = await aliceSdk.db.messages
      .where('[ownerUserId+contactUserId+direction]')
      .equals([aliceSdk.userId, bobSdk.userId, MessageDirection.OUTGOING])
      .toArray();
    expect(aliceOutgoingAfter.length).toBe(5);

    expect(aliceOutgoingAfter[0].status).toBe(MessageStatus.DELIVERED); // announcement message
    expect(aliceOutgoingAfter[1].status).toBe(MessageStatus.SENT); // WAITING_SESSION message is set as SENT
    expect(aliceOutgoingAfter[2].status).toBe(MessageStatus.SENT); // READY message is set as SENT
    expect(aliceOutgoingAfter[3].status).toBe(MessageStatus.SENT);
    expect(aliceOutgoingAfter[4].status).toBe(MessageStatus.DELIVERED);

    sendAnnouncementSpy.mockRestore();
  });

  it('Alice send announcement to bob. max_session_inactivity_millis delay pass but session is not killed (on both alice and bob side) since it is not active', async () => {
    await createCustomSdks(
      2000, // max_session_inactivity_millis: 2 seconds
      10000 // keep_alive_interval_millis: 10 seconds
    );

    const aliceBobContact: Omit<Contact, 'id'> = {
      ownerUserId: aliceSdk.userId,
      userId: bobSdk.userId,
      name: 'Bob',
      publicKeys: bobSdk.publicKeys.to_bytes(),
      avatar: undefined,
      isOnline: false,
      lastSeen: new Date(),
      createdAt: new Date(),
    };

    await aliceSdk.db.contacts.add(aliceBobContact);

    // Alice sends announcement (session becomes SelfRequested)
    const result = await aliceSdk.discussions.start(aliceBobContact);
    if (!result.success) throw result.error;

    // Bob fetches announcement (session becomes PeerRequested on his side)
    await bobSdk.announcements.fetch();

    // Verify sessions are not active
    expect(aliceSdk.discussions.getStatus(bobSdk.userId)).toBe(
      SessionStatus.SelfRequested
    );
    expect(bobSdk.discussions.getStatus(aliceSdk.userId)).toBe(
      SessionStatus.PeerRequested
    );

    // Spy on establishSession to verify it's called during reset
    const aliceAnnouncementService = (
      aliceSdk as unknown as { _announcement: AnnouncementService }
    )._announcement;
    const aliceEstablishSpy = vi.spyOn(
      aliceAnnouncementService,
      'establishSession'
    );
    const bobAnnouncementService = (
      bobSdk as unknown as { _announcement: AnnouncementService }
    )._announcement;
    const bobEstablishSpy = vi.spyOn(
      bobAnnouncementService,
      'establishSession'
    );

    // Wait for max_session_inactivity_millis (2000ms) + buffer
    await new Promise(resolve => setTimeout(resolve, 2100));

    // Call updateState on both
    await aliceSdk.updateState();
    await bobSdk.updateState();

    // Verify establishSession was not called (session was not renewed)
    expect(aliceEstablishSpy).not.toHaveBeenCalled();
    expect(bobEstablishSpy).not.toHaveBeenCalled();

    // Sessions should still be in same state (not killed)
    expect(aliceSdk.discussions.getStatus(bobSdk.userId)).toBe(
      SessionStatus.SelfRequested
    );
    expect(bobSdk.discussions.getStatus(aliceSdk.userId)).toBe(
      SessionStatus.PeerRequested
    );
  });

  it('Alice has not received incoming msg for too long, session is killed but session manager return error when attempt to renew. Retry and succeed', async () => {
    await createCustomSdks(
      2000, // max_session_inactivity_millis: 2 seconds
      10000 // keep_alive_interval_millis: 10 seconds
    );

    // Setup: Alice and Bob establish a session
    await setupSession(aliceSdk, bobSdk, 'Bob', 'Alice');

    // Set short retry delay
    // const originalRetryDelay =
    //   aliceSdk.config.announcements.retryDelayMs;
    // aliceSdk.config.announcements.retryDelayMs = 100;

    // Spy on establishSession to fail first time, then succeed
    const aliceAnnouncementService = (
      aliceSdk as unknown as { _announcement: AnnouncementService }
    )._announcement;
    const originalEstablishSession =
      aliceAnnouncementService.establishSession.bind(aliceAnnouncementService);
    let callCount = 0;
    const establishSpy = vi
      .spyOn(aliceAnnouncementService, 'establishSession')
      .mockImplementation(
        async (contactPublicKeys: UserPublicKeys, userData?: Uint8Array) => {
          callCount++;
          if (callCount === 1) {
            return {
              success: false,
              error: new Error('Session manager error'),
            };
          }
          return originalEstablishSession(contactPublicKeys, userData);
        }
      );

    // Wait for max_session_inactivity_millis
    await new Promise(resolve => setTimeout(resolve, 2100));

    // First updateState - should fail to renew
    await aliceSdk.updateState();

    expect(aliceSdk.discussions.getStatus(bobSdk.userId)).toBe(
      SessionStatus.Killed
    );
    const discussion = await aliceSdk.discussions.get(
      aliceSdk.userId,
      bobSdk.userId
    );
    expect(discussion?.sendAnnouncement).toBeNull();

    // // Wait for retry delay
    // await new Promise(resolve =>
    //   setTimeout(resolve, aliceSdk.config.announcements.retryDelayMs + 50)
    // );

    // Second updateState - should succeed
    await aliceSdk.updateState();

    // Verify establishSession was called twice
    expect(establishSpy).toHaveBeenCalledTimes(2);

    // Session should be active after successful retry
    expect(aliceSdk.discussions.getStatus(bobSdk.userId)).toBe(
      SessionStatus.Active
    );

    establishSpy.mockRestore();
    // aliceSdk.config.announcements.retryDelayMs = originalRetryDelay;
  });

  it('Alice has not received incoming msg for too long, session is killed but got network issue while reseting and sending announcement. Retry and success', async () => {
    await createCustomSdks(
      2000, // max_session_inactivity_millis: 2 seconds
      10000 // keep_alive_interval_millis: 10 seconds
    );

    // Setup: Alice and Bob establish a session
    await setupSession(aliceSdk, bobSdk, 'Bob', 'Alice');

    // Set short retry delay
    const originalRetryDelay = aliceSdk.config.announcements.retryDelayMs;
    aliceSdk.config.announcements.retryDelayMs = 100;

    // Set up spy to fail first time, then succeed
    const originalSendAnnouncement =
      MockMessageProtocol.prototype.sendAnnouncement;
    let callCount = 0;
    const sendSpy = vi
      .spyOn(mockProtocol, 'sendAnnouncement')
      .mockImplementation(async (announcement: Uint8Array) => {
        callCount++;
        if (callCount === 1) {
          throw new Error('Network error');
        }
        return originalSendAnnouncement.call(mockProtocol, announcement);
      });

    // Wait for max_session_inactivity_millis
    await new Promise(resolve => setTimeout(resolve, 2100));

    // First updateState - should fail to send announcement
    await aliceSdk.updateState();

    // Verify the announcement is still pending
    const discussion = await aliceSdk.discussions.get(
      aliceSdk.userId,
      bobSdk.userId
    );
    expect(discussion?.sendAnnouncement).not.toBeNull();
    // The announcement is not sent on network but session in session manager is active
    expect(aliceSdk.discussions.getStatus(bobSdk.userId)).toBe(
      SessionStatus.Active
    );

    // Wait for retry delay
    await new Promise(resolve =>
      setTimeout(resolve, aliceSdk.config.announcements.retryDelayMs + 50)
    );

    // Second updateState - should succeed
    await aliceSdk.updateState();

    const discussionAfterRetry = await aliceSdk.discussions.get(
      aliceSdk.userId,
      bobSdk.userId
    );
    expect(discussionAfterRetry?.sendAnnouncement).toBeNull();

    // Session should be active after successful retry
    expect(aliceSdk.discussions.getStatus(bobSdk.userId)).toBe(
      SessionStatus.Active
    );

    sendSpy.mockRestore();
    aliceSdk.config.announcements.retryDelayMs = originalRetryDelay;
  });

  it('Alice has not received incoming msg for too long, session is killed and need send keep alive. keep alive are not sent', async () => {
    // Create custom SDKs with shorter keep alive interval
    await createCustomSdks(
      2000, // max_session_inactivity_millis: 2 seconds
      1000 // keep_alive_interval_millis: 1 second
    );

    // Setup: Alice and Bob establish a session
    await setupSession(aliceSdk, bobSdk, 'Bob', 'Alice');

    // Verify session is active
    expect(await isLocalSessionUp(aliceSdk, bobSdk.userId)).toBe(true);

    // Wait for both keep_alive_interval (1000ms) and max_session_inactivity (2000ms)
    // After 1 second, keep alive would normally be sent
    // But after 2 seconds, session breaks and is renewed instead
    await new Promise(resolve => setTimeout(resolve, 2100));

    // Call updateState - this should trigger session reset (not keep alive)
    await aliceSdk.updateState();

    // Check that no keep alive messages were created in the database
    // Keep alive messages should have been skipped because session was being renewed
    const aliceMessages = await aliceSdk.db.messages
      .where('[ownerUserId+contactUserId]')
      .equals([aliceSdk.userId, bobSdk.userId])
      .and(msg => msg.type === MessageType.KEEP_ALIVE)
      .toArray();

    // Filter for keep alive messages (content is empty string)
    const keepAliveMessages = aliceMessages.filter(
      msg => msg.type === MessageType.KEEP_ALIVE
    );

    // No keep alive messages should have been sent (session renewal takes precedence)
    expect(keepAliveMessages.length).toBe(0);

    // Session should still be active after reset
    expect(aliceSdk.discussions.getStatus(bobSdk.userId)).toBe(
      SessionStatus.Active
    );
  });

  describe.only('Session saturation', () => {
    /**
     * Bob sends a simple text message to Alice,
     * then alice fetches bob's messages.
     *
     * Why ?
     * This is due to the functionning of session manager: Before the peer has sent it's first message,
     * the session is saturated after sending "max_session_lag_length - 1" messages.
     * This behaviour disapear when the peer has sent it's first message.
     * After that, the session become saturated after sending "max_session_lag_length" messages more than the peer has sent.
     * This is why we use this function to setup a state in which bob has sent his first message and hence
     * alice's session is saturated only after sending "max_session_lag_length" messages more than bob has sent.
     */
    async function BobSendFirstMsg(aliceSdk: GossipSdk, bobSdk: GossipSdk) {
      // Bob sends a message to Alice
      const bobSendResult = await bobSdk.messages.send({
        ownerUserId: bobSdk.userId,
        contactUserId: aliceSdk.userId,
        content: 'Hello Alice!',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.WAITING_SESSION,
        timestamp: new Date(),
      });
      expect(bobSendResult.success).toBe(true);

      // alice fetches bob's messages
      await aliceSdk.messages.fetch();
    }

    it('Alice send an announcement to Bob and send more than max_session_lag_length msg. But when calling state_update she is not saturated because her session has status selfRequested', async () => {
      await createCustomSdks(
        3600000, // max_session_inactivity_millis: 1 hour
        60000, // keep_alive_interval_millis: 1 minute
        3n // max_session_lag_length: 3 messages
      );

      // Alice adds Bob as a contact
      const aliceBobContact: Omit<Contact, 'id'> = {
        ownerUserId: aliceSdk.userId,
        userId: bobSdk.userId,
        name: 'Bob',
        publicKeys: bobSdk.publicKeys.to_bytes(),
        avatar: undefined,
        isOnline: false,
        lastSeen: new Date(),
        createdAt: new Date(),
      };
      await aliceSdk.db.contacts.add(aliceBobContact);

      // Alice initiates discussion with Bob (session status becomes SelfRequested)
      const result = await aliceSdk.discussions.start(aliceBobContact);
      if (!result.success) throw result.error;

      // Verify session status is SelfRequested
      expect(aliceSdk.discussions.getStatus(bobSdk.userId)).toBe(
        SessionStatus.SelfRequested
      );

      // Alice sends 4 messages (more than max_session_lag_length = 3)
      for (let i = 1; i <= 4; i++) {
        const msgResult = await aliceSdk.messages.send({
          ownerUserId: aliceSdk.userId,
          contactUserId: bobSdk.userId,
          content: `Message ${i}`,
          type: MessageType.TEXT,
          direction: MessageDirection.OUTGOING,
          status: MessageStatus.WAITING_SESSION,
          timestamp: new Date(),
        });
        expect(msgResult.success).toBe(true);
      }

      // would have set the session as saturated if it was active.
      await aliceSdk.updateState();

      // Session should still be SelfRequested (not Saturated)
      expect(aliceSdk.discussions.getStatus(bobSdk.userId)).toBe(
        SessionStatus.SelfRequested
      );
    });

    it('Alice become saturated, bob send her a message before calling state_update -> session is not reset', async () => {
      await createCustomSdks(
        3600000, // max_session_inactivity_millis: 1 hour
        60000, // keep_alive_interval_millis: 1 minute
        3n // max_session_lag_length: 3 messages
      );

      // Setup: Alice and Bob establish a session
      await setupSession(aliceSdk, bobSdk, 'Bob', 'Alice');

      // Verify session is active
      expect(await isLocalSessionUp(aliceSdk, bobSdk.userId)).toBe(true);

      // Bob sends his first message to Alice
      await BobSendFirstMsg(aliceSdk, bobSdk);

      // Alice sends 3 messages (exactly max_session_lag_length)
      for (let i = 1; i <= 3; i++) {
        const msgResult = await aliceSdk.messages.send({
          ownerUserId: aliceSdk.userId,
          contactUserId: bobSdk.userId,
          content: `Alice message ${i}`,
          type: MessageType.TEXT,
          direction: MessageDirection.OUTGOING,
          status: MessageStatus.WAITING_SESSION,
          timestamp: new Date(),
        });
        expect(msgResult.success).toBe(true);
      }
      /* The last message is added directly in db because the aliceSdk.messages.send call
       state_update and it would have set the session as saturated */
      // await db.messages.add({
      //   ownerUserId: aliceSdk.userId,
      //   contactUserId: bobSdk.userId,
      //   messageId: new Uint8Array(12).fill(3),
      //   content: 'Alice message 3',
      //   type: MessageType.TEXT,
      //   direction: MessageDirection.OUTGOING,
      //   status: MessageStatus.WAITING_SESSION,
      //   timestamp: new Date(),
      // });

      // Check if Alice is saturated
      expect(aliceSdk.discussions.getStatus(bobSdk.userId)).toBe(
        SessionStatus.Saturated
      );

      // bob fetches alice's messages
      await bobSdk.messages.fetch();

      // Bob sends a message to Alice (this acknowledges Alice's messages)
      const bobMsgResult = await bobSdk.messages.send({
        ownerUserId: bobSdk.userId,
        contactUserId: aliceSdk.userId,
        content: 'Bob response',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.WAITING_SESSION,
        timestamp: new Date(),
      });
      expect(bobMsgResult.success).toBe(true);

      // Alice fetches Bob's message (this acknowledges her messages, reducing lag)
      await aliceSdk.messages.fetch();

      // Session should be Active again (not Saturated, not reset)
      expect(aliceSdk.discussions.getStatus(bobSdk.userId)).toBe(
        SessionStatus.Active
      );
    });

    it('Alice become saturated, session is reset all messages are resent, bob answer, no more saturation', async () => {
      await createCustomSdks(
        3600000, // max_session_inactivity_millis: 1 hour
        60000, // keep_alive_interval_millis: 1 minute
        3n // max_session_lag_length: 3 messages
      );

      // Setup: Alice and Bob establish a session
      await setupSession(aliceSdk, bobSdk, 'Bob', 'Alice');

      // Verify session is active
      expect(await isLocalSessionUp(aliceSdk, bobSdk.userId)).toBe(true);

      // Bob sends his first message to Alice
      await BobSendFirstMsg(aliceSdk, bobSdk);

      // Alice sends 3 messages (exactly max_session_lag_length)
      for (let i = 1; i <= 3; i++) {
        const msgResult = await aliceSdk.messages.send({
          ownerUserId: aliceSdk.userId,
          contactUserId: bobSdk.userId,
          content: `Alice message ${i}`,
          type: MessageType.TEXT,
          direction: MessageDirection.OUTGOING,
          status: MessageStatus.WAITING_SESSION,
          timestamp: new Date(),
        });
        expect(msgResult.success).toBe(true);
      }

      // Verify Alice is saturated
      expect(aliceSdk.discussions.getStatus(bobSdk.userId)).toBe(
        SessionStatus.Saturated
      );

      // Call updateState - this should reset the session because it's saturated
      // and resend all messages
      await aliceSdk.updateState();

      // Bob fetches announcements (receives renewal)
      await bobSdk.announcements.fetch();

      // Bob fetches messages and receives Alice's messages
      await bobSdk.messages.fetch();
      const bobMessages = await bobSdk.messages.getMessages(aliceSdk.userId);
      const bobIncoming = bobMessages.filter(
        m => m.direction === MessageDirection.INCOMING
      );
      // the 3rd msg has not been sent because session is saturated.
      // This is because the session has been reset and there is a virtual lag of 1 msg so max_session_lag_length is reached at the 2nd msg
      expect(bobIncoming.length).toEqual(2);

      // Bob answers (this acknowledges Alice's messages)
      const bobMsgResult = await bobSdk.messages.send({
        ownerUserId: bobSdk.userId,
        contactUserId: aliceSdk.userId,
        content: 'Bob response',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.WAITING_SESSION,
        timestamp: new Date(),
      });
      expect(bobMsgResult.success).toBe(true);

      // Alice fetches Bob's message (this acknowledges her messages)
      await aliceSdk.messages.fetch();

      // Session should be Active (not Saturated)
      expect(aliceSdk.discussions.getStatus(bobSdk.userId)).toBe(
        SessionStatus.Active
      );

      // alice resend her 3rd msg
      await aliceSdk.updateState();

      // Bob fetches announcements (receives Alice's renewal)
      await bobSdk.announcements.fetch();

      // Bob fetches messages and receives Alice's messages
      await bobSdk.messages.fetch();
      const bobMessages2 = await bobSdk.messages.getMessages(aliceSdk.userId);
      const bobIncoming2 = bobMessages2.filter(
        m => m.direction === MessageDirection.INCOMING
      );
      expect(bobIncoming2.length).toEqual(3);
    });

    it.skip("Alice and bob both become saturated because network lag. Alice session is reset, bob's no. They fetch messages and are no more saturated", async () => {
      await createCustomSdks(
        3600000, // max_session_inactivity_millis: 1 hour
        60000, // keep_alive_interval_millis: 1 minute
        3n // max_session_lag_length: 3 messages
      );

      // Setup: Alice and Bob establish a session
      await setupSession(aliceSdk, bobSdk, 'Bob', 'Alice');

      // Verify session is active
      expect(await isLocalSessionUp(aliceSdk, bobSdk.userId)).toBe(true);
      expect(await isLocalSessionUp(bobSdk, aliceSdk.userId)).toBe(true);

      // Bob sends his first message to Alice
      await BobSendFirstMsg(aliceSdk, bobSdk);

      // Alice sends 3 messages (exactly max_session_lag_length)
      for (let i = 1; i <= 3; i++) {
        const msgResult = await aliceSdk.messages.send({
          ownerUserId: aliceSdk.userId,
          contactUserId: bobSdk.userId,
          content: `Alice message ${i}`,
          type: MessageType.TEXT,
          direction: MessageDirection.OUTGOING,
          status: MessageStatus.WAITING_SESSION,
          timestamp: new Date(),
        });
        expect(msgResult.success).toBe(true);
      }

      // Bob sends 2 messages (with the 1st msg previously sent it reach exactly max_session_lag_length)
      for (let i = 1; i <= 2; i++) {
        const msgResult = await bobSdk.messages.send({
          ownerUserId: bobSdk.userId,
          contactUserId: aliceSdk.userId,
          content: `Bob message ${i}`,
          type: MessageType.TEXT,
          direction: MessageDirection.OUTGOING,
          status: MessageStatus.WAITING_SESSION,
          timestamp: new Date(),
        });
        expect(msgResult.success).toBe(true);
      }

      // Verify both are saturated
      expect(aliceSdk.discussions.getStatus(bobSdk.userId)).toBe(
        SessionStatus.Saturated
      );
      expect(bobSdk.discussions.getStatus(aliceSdk.userId)).toBe(
        SessionStatus.Saturated
      );

      // Alice calls updateState - her session should be reset
      await aliceSdk.updateState();

      // Bob fetches announcements (receives Alice's renewal)
      await bobSdk.announcements.fetch();

      // Bob fetches messages (receives Alice's messages, acknowledging them)
      await bobSdk.messages.fetch();

      // Alice fetches messages (receives Bob's messages, acknowledging them)
      await aliceSdk.messages.fetch();

      // Both sessions should still be Saturated because their respective message don't acknowledge the other's messages
      expect(aliceSdk.discussions.getStatus(bobSdk.userId)).toBe(
        SessionStatus.Saturated
      );
      expect(bobSdk.discussions.getStatus(aliceSdk.userId)).toBe(
        SessionStatus.Saturated
      );

      // Alice send her 4th msg
      const aliceMsgResult = await aliceSdk.messages.send({
        ownerUserId: aliceSdk.userId,
        contactUserId: bobSdk.userId,
        content: `Alice message 4`,
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.WAITING_SESSION,
        timestamp: new Date(),
      });
      expect(aliceMsgResult.success).toBe(true);

      // Bob fetch messages and receive Alice's 4th msg
      await bobSdk.messages.fetch();

      // Bob's session should be Active because he has received Alice's 4th msg
      expect(bobSdk.discussions.getStatus(aliceSdk.userId)).toBe(
        SessionStatus.Active
      );

      // bob send his 4th msg
      const bobMsgResult = await bobSdk.messages.send({
        ownerUserId: bobSdk.userId,
        contactUserId: aliceSdk.userId,
        content: `Bob message 4`,
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.WAITING_SESSION,
        timestamp: new Date(),
      });
      expect(bobMsgResult.success).toBe(true);

      // Alice fetch messages and receive Bob's 4th msg
      await aliceSdk.messages.fetch();

      // Alice's session should be Active because she has received Bob's 4th msg
      expect(aliceSdk.discussions.getStatus(bobSdk.userId)).toBe(
        SessionStatus.Active
      );
    });
  });
});
