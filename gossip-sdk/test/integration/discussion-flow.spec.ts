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
import { db, Contact, DiscussionDirection } from '../../src/db';
import { MockMessageProtocol } from '../mocks';
import {
  createTestSession,
  cleanupTestSession,
  TestSessionData,
} from '../utils';
import { encodeAnnouncementPayload } from '../../src/utils/announcementPayload';
import { GossipSdkImpl } from '../../src/gossipSdk';
import { ensureWasmInitialized } from '../../src/wasm/loader';
import { generateMnemonic } from '../../src/crypto/bip39';
import { generateEncryptionKey } from '../../src/wasm/encryption';
import { SessionStatus } from '../../src/assets/generated/wasm/gossip_wasm';
import { AnnouncementService } from '../../src/services/announcement';
import { MessageService } from '../../src/services/message';
import { UserPublicKeys } from '../../src/assets/generated/wasm/gossip_wasm';

/**
 * Utility function to check if a session is fully up and active.
 * Verifies:
 * - Session status is Active
 * - Discussion weAccepted is true
 * - sendAnnouncement is null (no pending announcements)
 */
async function isLocalSessionUp(
  sdk: GossipSdkImpl,
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
  aliceSdk: GossipSdkImpl,
  bobSdk: GossipSdkImpl
): Promise<boolean> {
  return (
    (await isLocalSessionUp(aliceSdk, bobSdk.userId)) &&
    (await isLocalSessionUp(bobSdk, aliceSdk.userId))
  );
}

describe('Discussion Flow', () => {
  let mockProtocol: MockMessageProtocol;

  let alice: TestSessionData;
  let aliceSdk: GossipSdkImpl;

  let bob: TestSessionData;
  let bobSdk: GossipSdkImpl;

  beforeAll(async () => {
    await ensureWasmInitialized();
    mockProtocol = new MockMessageProtocol();
  });

  beforeEach(async () => {
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
    aliceSdk = new GossipSdkImpl();
    await aliceSdk.init({
      db,
    });
    await aliceSdk.openSession({
      mnemonic: aliceMnemonic,
      onPersist: async () => {},
      persistEncryptionKey: aliceEncryptionKey,
    });
    // Replace protocol with mock for testing
    (
      aliceSdk as unknown as { _announcement: AnnouncementService }
    )._announcement.setMessageProtocol(mockProtocol);
    (aliceSdk as unknown as { _message: MessageService })._message[
      'messageProtocol'
    ] = mockProtocol;

    bobSdk = new GossipSdkImpl();
    await bobSdk.init({
      db,
    });
    await bobSdk.openSession({
      mnemonic: bobMnemonic,
      onPersist: async () => {},
      persistEncryptionKey: bobEncryptionKey,
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

      const bobDiscussion = await db.getDiscussionByOwnerAndContact(
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

      const bobDiscussion = await db.getDiscussionByOwnerAndContact(
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

      const bobDiscussion = await db.getDiscussionByOwnerAndContact(
        bobSdk.userId,
        alice.session.userIdEncoded
      );

      expect(bobDiscussion?.lastAnnouncementMessage).toBeUndefined();
    });

    it('Bob receives announcement without username (no colon in message)', async () => {
      const oldFormatMessage = 'Hi, this is an old format message';
      const userData = new TextEncoder().encode(oldFormatMessage);

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

      const bobDiscussion = await db.getDiscussionByOwnerAndContact(
        bobSdk.userId,
        alice.session.userIdEncoded
      );

      expect(bobDiscussion?.lastAnnouncementMessage).toBe(oldFormatMessage);
    });

    it('Bob receives JSON announcement with special characters (colons in message)', async () => {
      const jsonPayload = JSON.stringify({
        u: 'Alice:Smith',
        m: 'Hello: how are you?',
      });
      const userData = new TextEncoder().encode(jsonPayload);

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
      expect(bobContact?.name).toBe('Alice:Smith');

      const bobDiscussion = await db.getDiscussionByOwnerAndContact(
        bobSdk.userId,
        alice.session.userIdEncoded
      );

      expect(bobDiscussion?.lastAnnouncementMessage).toBe(
        'Hello: how are you?'
      );
    });

    it('Bob receives legacy colon format (backwards compatibility)', async () => {
      const legacyMessage = 'OldAlice:Hello from old client';
      const userData = new TextEncoder().encode(legacyMessage);

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

      expect(bobContact?.name).toBe('OldAlice');

      const bobDiscussion = await db.getDiscussionByOwnerAndContact(
        bobSdk.userId,
        alice.session.userIdEncoded
      );

      expect(bobDiscussion?.lastAnnouncementMessage).toBe(
        'Hello from old client'
      );
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

      const bobDiscussion = await db.getDiscussionByOwnerAndContact(
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

      const bobDiscussion = await db.getDiscussionByOwnerAndContact(
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
      const bobDiscussionAfterRefuse = await db.getDiscussionByOwnerAndContact(
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

      const bobDiscussion = await db.getDiscussionByOwnerAndContact(
        bobSdk.userId,
        aliceSdk.userId
      );
      expect(bobDiscussion).toBeDefined();

      // Bob refuses by deleting the contact
      await bobSdk.contacts.delete(bobSdk.userId, aliceSdk.userId);

      // Verify Bob's side is cleaned up
      const bobDiscussionAfterRefuse = await db.getDiscussionByOwnerAndContact(
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

      const aliceDiscussionFromBob = await db.getDiscussionByOwnerAndContact(
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

      const bobDiscussion = await db.getDiscussionByOwnerAndContact(
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
      const startResult = await aliceSdk.discussions.start(
        aliceBobContact,
        announcementMsg
      );
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

      let bobDiscussion = await db.getDiscussionByOwnerAndContact(
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

      bobDiscussion = await db.getDiscussionByOwnerAndContact(
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

      const bobDiscussion = await db.getDiscussionByOwnerAndContact(
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
      console.log(
        'await aliceSdk.discussions.get(aliceSdk.userId, bobSdk.userId): ',
        await aliceSdk.discussions.get(aliceSdk.userId, bobSdk.userId)
      );
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
      console.log('res of bobSdk.announcements.fetch', res);
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
});
