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
import { AnnouncementService } from '../../src/services/announcement.js';
import { DiscussionService } from '../../src/services/discussion.js';
import { db, Contact, DiscussionStatus } from '../../src/db.js';
import { MockMessageProtocol } from '../mocks/index.js';
import {
  createTestSession,
  cleanupTestSession,
  TestSessionData,
} from '../utils.js';

describe('Discussion Flow', () => {
  let mockProtocol: MockMessageProtocol;

  let alice: TestSessionData;
  let aliceAnnouncementService: AnnouncementService;
  let aliceDiscussionService: DiscussionService;

  let bob: TestSessionData;
  let bobAnnouncementService: AnnouncementService;
  let bobDiscussionService: DiscussionService;

  beforeAll(async () => {
    mockProtocol = new MockMessageProtocol();
  });

  beforeEach(async () => {
    if (!db.isOpen()) {
      await db.open();
    }
    await Promise.all(db.tables.map(table => table.clear()));
    mockProtocol.clearMockData();

    vi.clearAllMocks();

    // Create real WASM sessions for Alice and Bob
    alice = await createTestSession(`alice-${Date.now()}-${Math.random()}`);
    bob = await createTestSession(`bob-${Date.now()}-${Math.random()}`);

    aliceAnnouncementService = new AnnouncementService(
      db,
      mockProtocol,
      alice.session
    );
    aliceDiscussionService = new DiscussionService(
      db,
      aliceAnnouncementService,
      alice.session
    );

    bobAnnouncementService = new AnnouncementService(
      db,
      mockProtocol,
      bob.session
    );
    bobDiscussionService = new DiscussionService(
      db,
      bobAnnouncementService,
      bob.session
    );
  });

  afterEach(async () => {
    cleanupTestSession(alice);
    cleanupTestSession(bob);
  });

  describe('Announcement Username Parsing', () => {
    it('Bob receives announcement with username and uses it as contact name', async () => {
      // Alice creates announcement with username in user_data
      const jsonPayload = JSON.stringify({
        u: 'Alice',
        m: 'Hi, I would like to connect!',
      });
      const userData = new TextEncoder().encode(jsonPayload);

      // Alice establishes outgoing session to Bob with user data
      const aliceAnnouncement = await alice.session.establishOutgoingSession(
        bob.session.ourPk,
        userData
      );

      // Store the announcement (simulates network)
      await mockProtocol.sendAnnouncement(aliceAnnouncement);

      // Bob fetches and processes announcements
      await bobAnnouncementService.fetchAndProcessAnnouncements();

      // Bob should have Alice as a contact with the username from announcement
      const bobContact = await db.getContactByOwnerAndUserId(
        bob.session.userIdEncoded,
        alice.session.userIdEncoded
      );

      expect(bobContact).toBeDefined();
      expect(bobContact?.name).toBe('Alice');

      const bobDiscussion = await db.getDiscussionByOwnerAndContact(
        bob.session.userIdEncoded,
        alice.session.userIdEncoded
      );

      expect(bobDiscussion).toBeDefined();
      expect(bobDiscussion?.announcementMessage).toBe(
        'Hi, I would like to connect!'
      );
    });

    it('Bob receives JSON announcement without username (message only)', async () => {
      const jsonPayload = JSON.stringify({ m: 'Hello without username' });
      const userData = new TextEncoder().encode(jsonPayload);

      const aliceAnnouncement = await alice.session.establishOutgoingSession(
        bob.session.ourPk,
        userData
      );

      await mockProtocol.sendAnnouncement(aliceAnnouncement);
      await bobAnnouncementService.fetchAndProcessAnnouncements();

      const bobContact = await db.getContactByOwnerAndUserId(
        bob.session.userIdEncoded,
        alice.session.userIdEncoded
      );

      expect(bobContact).toBeDefined();
      expect(bobContact?.name).toMatch(/^New Request \d+$/);

      const bobDiscussion = await db.getDiscussionByOwnerAndContact(
        bob.session.userIdEncoded,
        alice.session.userIdEncoded
      );

      expect(bobDiscussion?.announcementMessage).toBe('Hello without username');
    });

    it('Bob receives announcement with username only (no message)', async () => {
      const jsonPayload = JSON.stringify({ u: 'AliceUser' });
      const userData = new TextEncoder().encode(jsonPayload);

      const aliceAnnouncement = await alice.session.establishOutgoingSession(
        bob.session.ourPk,
        userData
      );

      await mockProtocol.sendAnnouncement(aliceAnnouncement);
      await bobAnnouncementService.fetchAndProcessAnnouncements();

      const bobContact = await db.getContactByOwnerAndUserId(
        bob.session.userIdEncoded,
        alice.session.userIdEncoded
      );

      expect(bobContact).toBeDefined();
      expect(bobContact?.name).toBe('AliceUser');

      const bobDiscussion = await db.getDiscussionByOwnerAndContact(
        bob.session.userIdEncoded,
        alice.session.userIdEncoded
      );

      expect(bobDiscussion?.announcementMessage).toBeUndefined();
    });

    it('Bob receives announcement without username (no colon in message)', async () => {
      const oldFormatMessage = 'Hi, this is an old format message';
      const userData = new TextEncoder().encode(oldFormatMessage);

      const aliceAnnouncement = await alice.session.establishOutgoingSession(
        bob.session.ourPk,
        userData
      );

      await mockProtocol.sendAnnouncement(aliceAnnouncement);
      await bobAnnouncementService.fetchAndProcessAnnouncements();

      const bobContact = await db.getContactByOwnerAndUserId(
        bob.session.userIdEncoded,
        alice.session.userIdEncoded
      );

      expect(bobContact).toBeDefined();
      expect(bobContact?.name).toMatch(/^New Request \d+$/);

      const bobDiscussion = await db.getDiscussionByOwnerAndContact(
        bob.session.userIdEncoded,
        alice.session.userIdEncoded
      );

      expect(bobDiscussion?.announcementMessage).toBe(oldFormatMessage);
    });

    it('Bob receives JSON announcement with special characters (colons in message)', async () => {
      const jsonPayload = JSON.stringify({
        u: 'Alice:Smith',
        m: 'Hello: how are you?',
      });
      const userData = new TextEncoder().encode(jsonPayload);

      const aliceAnnouncement = await alice.session.establishOutgoingSession(
        bob.session.ourPk,
        userData
      );

      await mockProtocol.sendAnnouncement(aliceAnnouncement);
      await bobAnnouncementService.fetchAndProcessAnnouncements();

      const bobContact = await db.getContactByOwnerAndUserId(
        bob.session.userIdEncoded,
        alice.session.userIdEncoded
      );

      expect(bobContact).toBeDefined();
      expect(bobContact?.name).toBe('Alice:Smith');

      const bobDiscussion = await db.getDiscussionByOwnerAndContact(
        bob.session.userIdEncoded,
        alice.session.userIdEncoded
      );

      expect(bobDiscussion?.announcementMessage).toBe('Hello: how are you?');
    });

    it('Bob receives legacy colon format (backwards compatibility)', async () => {
      const legacyMessage = 'OldAlice:Hello from old client';
      const userData = new TextEncoder().encode(legacyMessage);

      const aliceAnnouncement = await alice.session.establishOutgoingSession(
        bob.session.ourPk,
        userData
      );

      await mockProtocol.sendAnnouncement(aliceAnnouncement);
      await bobAnnouncementService.fetchAndProcessAnnouncements();

      const bobContact = await db.getContactByOwnerAndUserId(
        bob.session.userIdEncoded,
        alice.session.userIdEncoded
      );

      expect(bobContact?.name).toBe('OldAlice');

      const bobDiscussion = await db.getDiscussionByOwnerAndContact(
        bob.session.userIdEncoded,
        alice.session.userIdEncoded
      );

      expect(bobDiscussion?.announcementMessage).toBe('Hello from old client');
    });
  });

  describe('Discussion Initiation Happy Path', () => {
    it('Alice sends announcement and Bob accepts', async () => {
      // Alice adds Bob as a contact first
      const aliceBobContact: Omit<Contact, 'id'> = {
        ownerUserId: alice.session.userIdEncoded,
        userId: bob.session.userIdEncoded,
        name: 'Bob',
        publicKeys: bob.session.ourPk.to_bytes(),
        avatar: undefined,
        isOnline: false,
        lastSeen: new Date(),
        createdAt: new Date(),
      };

      await db.contacts.add(aliceBobContact);

      // Alice initiates discussion with Bob
      const { discussionId: aliceDiscussionId } =
        await aliceDiscussionService.initialize(aliceBobContact);

      const aliceDiscussion = await db.discussions.get(aliceDiscussionId);
      expect(aliceDiscussion).toBeDefined();
      expect(aliceDiscussion?.status).toBe(DiscussionStatus.PENDING);
      expect(aliceDiscussion?.direction).toBe('initiated');
      expect(aliceDiscussion?.initiationAnnouncement).toBeDefined();

      // Bob fetches announcements and sees Alice's request
      await bobAnnouncementService.fetchAndProcessAnnouncements();

      const bobDiscussion = await db.getDiscussionByOwnerAndContact(
        bob.session.userIdEncoded,
        alice.session.userIdEncoded
      );

      expect(bobDiscussion).toBeDefined();
      expect(bobDiscussion?.status).toBe(DiscussionStatus.PENDING);
      expect(bobDiscussion?.direction).toBe('received');

      if (!bobDiscussion) throw new Error('Bob discussion not found');

      // Bob accepts the discussion
      await bobDiscussionService.accept(bobDiscussion);

      const bobDiscussionAfterAccept = await db.discussions.get(
        bobDiscussion.id!
      );
      expect(bobDiscussionAfterAccept?.status).toBe(DiscussionStatus.ACTIVE);
      expect(bobDiscussionAfterAccept?.initiationAnnouncement).toBeDefined();

      // Alice fetches announcements and sees Bob's acceptance
      await aliceAnnouncementService.fetchAndProcessAnnouncements();

      const aliceDiscussionAfterAcceptance =
        await db.discussions.get(aliceDiscussionId);
      expect(aliceDiscussionAfterAcceptance?.status).toBe(
        DiscussionStatus.ACTIVE
      );
    });

    it('Both Alice and Bob send announcement at the same time', async () => {
      // Alice adds Bob as contact
      const aliceBobContact: Omit<Contact, 'id'> = {
        ownerUserId: alice.session.userIdEncoded,
        userId: bob.session.userIdEncoded,
        name: 'Bob',
        publicKeys: bob.session.ourPk.to_bytes(),
        avatar: undefined,
        isOnline: false,
        lastSeen: new Date(),
        createdAt: new Date(),
      };

      await db.contacts.add(aliceBobContact);

      // Bob adds Alice as contact
      const bobAliceContact: Omit<Contact, 'id'> = {
        ownerUserId: bob.session.userIdEncoded,
        userId: alice.session.userIdEncoded,
        name: 'Alice',
        publicKeys: alice.session.ourPk.to_bytes(),
        avatar: undefined,
        isOnline: false,
        lastSeen: new Date(),
        createdAt: new Date(),
      };

      await db.contacts.add(bobAliceContact);

      // Both initiate at the same time
      const { discussionId: aliceDiscussionId } =
        await aliceDiscussionService.initialize(aliceBobContact);

      const { discussionId: bobDiscussionId } =
        await bobDiscussionService.initialize(bobAliceContact);

      const aliceDiscussion = await db.discussions.get(aliceDiscussionId);
      expect(aliceDiscussion?.status).toBe(DiscussionStatus.PENDING);
      expect(aliceDiscussion?.direction).toBe('initiated');

      const bobDiscussion = await db.discussions.get(bobDiscussionId);
      expect(bobDiscussion?.status).toBe(DiscussionStatus.PENDING);
      expect(bobDiscussion?.direction).toBe('initiated');

      // Alice fetches and sees Bob's announcement
      await aliceAnnouncementService.fetchAndProcessAnnouncements();

      const aliceDiscussionAfterFetch =
        await db.discussions.get(aliceDiscussionId);
      expect(aliceDiscussionAfterFetch?.status).toBe(DiscussionStatus.ACTIVE);

      // Bob fetches and sees Alice's announcement
      await bobAnnouncementService.fetchAndProcessAnnouncements();

      const bobDiscussionAfterFetch = await db.discussions.get(bobDiscussionId);
      expect(bobDiscussionAfterFetch?.status).toBe(DiscussionStatus.ACTIVE);
    });
  });

  describe('Discussion Initiation Failures', () => {
    it('Alice signs announcement but network fails, then resend succeeds', async () => {
      const aliceBobContact: Omit<Contact, 'id'> = {
        ownerUserId: alice.session.userIdEncoded,
        userId: bob.session.userIdEncoded,
        name: 'Bob',
        publicKeys: bob.session.ourPk.to_bytes(),
        avatar: undefined,
        isOnline: false,
        lastSeen: new Date(),
        createdAt: new Date(),
      };

      await db.contacts.add(aliceBobContact);

      // Make network fail on first attempt
      vi.spyOn(mockProtocol, 'sendAnnouncement')
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValue('counter-123');

      const { discussionId: aliceDiscussionId } =
        await aliceDiscussionService.initialize(aliceBobContact);

      let aliceDiscussion = await db.discussions.get(aliceDiscussionId);
      expect(aliceDiscussion?.status).toBe(DiscussionStatus.SEND_FAILED);

      await new Promise(resolve => setTimeout(resolve, 100));

      // Resend should succeed
      await aliceAnnouncementService.resendAnnouncements([aliceDiscussion!]);

      aliceDiscussion = await db.discussions.get(aliceDiscussionId);
      // After resend, status depends on whether Bob has responded
      // At minimum it should not be SEND_FAILED anymore
      expect(aliceDiscussion?.status).not.toBe(DiscussionStatus.SEND_FAILED);
    });
  });
});
