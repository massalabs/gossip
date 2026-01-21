/**
 * Discussion Flow Tests
 *
 * Tests for the complete discussion flow including:
 * - Discussion initiation (Alice/Bob scenarios)
 * - Announcement username parsing
 * - Network failures and retries
 * - Session renewal
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  beforeAll,
} from 'vitest';
import { db, Contact, DiscussionStatus } from '../src/db';
import { AnnouncementService } from '../src/services/announcement';
import { DiscussionService } from '../src/services/discussion';
import {
  SessionStatus,
  UserPublicKeys,
  UserSecretKeys,
} from '../src/assets/generated/wasm/gossip_wasm';
import { generateUserKeys } from '../src/wasm/userKeys';
import type { SessionModule } from '../src/wasm/session';
import { MockSessionModule, MockMessageProtocol } from './mocks';
import { initializeSessionMock } from './helpers';

describe('Discussion Flow', () => {
  let mockProtocol: MockMessageProtocol;

  // Alice's test data
  let aliceSession: MockSessionModule;
  let alicePk: UserPublicKeys;
  let aliceSk: UserSecretKeys;
  let aliceAnnouncementService: AnnouncementService;
  let aliceDiscussionService: DiscussionService;

  // Bob's test data
  let bobSession: MockSessionModule;
  let bobPk: UserPublicKeys;
  let bobSk: UserSecretKeys;
  let bobAnnouncementService: AnnouncementService;
  let bobDiscussionService: DiscussionService;

  // Initialize mock protocol before all tests
  beforeAll(async () => {
    mockProtocol = new MockMessageProtocol();
  });

  beforeEach(async () => {
    // Database cleanup
    if (!db.isOpen()) {
      await db.open();
    }
    await Promise.all(db.tables.map(table => table.clear()));

    // Reset all mocks
    vi.clearAllMocks();

    // Generate Alice's keys using real WASM
    const generatedAliceKeys = await generateUserKeys(
      `alice-test-passphrase-${Date.now()}-${Math.random()}`
    );
    alicePk = generatedAliceKeys.public_keys();
    aliceSk = generatedAliceKeys.secret_keys();
    generatedAliceKeys.free();
    aliceSession = initializeSessionMock(alicePk, aliceSk);

    // Create Alice's services with her session
    aliceAnnouncementService = new AnnouncementService(
      db,
      mockProtocol,
      aliceSession as unknown as SessionModule
    );
    aliceDiscussionService = new DiscussionService(
      db,
      aliceAnnouncementService,
      aliceSession as unknown as SessionModule
    );

    // Generate Bob's keys using real WASM
    const generatedBobKeys = await generateUserKeys(
      `bob-test-passphrase-${Date.now()}-${Math.random()}`
    );
    bobPk = generatedBobKeys.public_keys();
    bobSk = generatedBobKeys.secret_keys();
    generatedBobKeys.free();
    bobSession = initializeSessionMock(bobPk, bobSk);

    // Create Bob's services with his session
    bobAnnouncementService = new AnnouncementService(
      db,
      mockProtocol,
      bobSession as unknown as SessionModule
    );
    bobDiscussionService = new DiscussionService(
      db,
      bobAnnouncementService,
      bobSession as unknown as SessionModule
    );
  });

  afterEach(async () => {
    // Free WASM objects to prevent memory leaks
    if (alicePk) {
      alicePk.free();
      alicePk = null as any;
    }
    if (aliceSk) {
      aliceSk.free();
      aliceSk = null as any;
    }
    if (bobPk) {
      bobPk.free();
      bobPk = null as any;
    }
    if (bobSk) {
      bobSk.free();
      bobSk = null as any;
    }
  });

  describe('Announcement Username Parsing', () => {
    it('Bob receives announcement with username and uses it as contact name', async () => {
      // Alice sends announcement with username:message format
      const aliceAnnouncement = new Uint8Array(200);
      crypto.getRandomValues(aliceAnnouncement);
      aliceSession.establishOutgoingSession.mockReturnValue(aliceAnnouncement);

      // Mock Bob receiving announcement with username in user_data
      const usernameMessage = 'Alice:Hi, I would like to connect!';
      const encodedUserData = new TextEncoder().encode(usernameMessage);

      bobSession.feedIncomingAnnouncement.mockReturnValue({
        announcer_public_keys: alicePk,
        timestamp: Date.now(),
        user_data: encodedUserData,
      } as any);

      vi.spyOn(mockProtocol, 'fetchAnnouncements').mockResolvedValue([
        { counter: '1', data: aliceAnnouncement },
      ]);

      await bobAnnouncementService.fetchAndProcessAnnouncements();

      // Verify contact was created with the username from announcement
      const bobContact = await db.getContactByOwnerAndUserId(
        bobSession.userIdEncoded,
        aliceSession.userIdEncoded
      );

      expect(bobContact).toBeDefined();
      expect(bobContact?.name).toBe('Alice');

      // Verify discussion has the message without username prefix
      const bobDiscussion = await db.getDiscussionByOwnerAndContact(
        bobSession.userIdEncoded,
        aliceSession.userIdEncoded
      );

      expect(bobDiscussion).toBeDefined();
      expect(bobDiscussion?.announcementMessage).toBe(
        'Hi, I would like to connect!'
      );
    });

    it('Bob receives legacy format announcement with empty username (colon prefix)', async () => {
      const aliceAnnouncement = new Uint8Array(200);
      crypto.getRandomValues(aliceAnnouncement);

      // Legacy format: colon with no username before it
      // This could come from older clients that always included the colon
      const usernameMessage = ':Hello without username';
      const encodedUserData = new TextEncoder().encode(usernameMessage);

      bobSession.feedIncomingAnnouncement.mockReturnValue({
        announcer_public_keys: alicePk,
        timestamp: Date.now(),
        user_data: encodedUserData,
      } as any);

      vi.spyOn(mockProtocol, 'fetchAnnouncements').mockResolvedValue([
        { counter: '1', data: aliceAnnouncement },
      ]);

      await bobAnnouncementService.fetchAndProcessAnnouncements();

      // Verify contact was created with generated temporary name
      const bobContact = await db.getContactByOwnerAndUserId(
        bobSession.userIdEncoded,
        aliceSession.userIdEncoded
      );

      expect(bobContact).toBeDefined();
      expect(bobContact?.name).toMatch(/^New Request \d+$/);

      // Verify discussion has the message
      const bobDiscussion = await db.getDiscussionByOwnerAndContact(
        bobSession.userIdEncoded,
        aliceSession.userIdEncoded
      );

      expect(bobDiscussion?.announcementMessage).toBe('Hello without username');
    });

    it('Bob receives announcement with username only (no message)', async () => {
      const aliceAnnouncement = new Uint8Array(200);
      crypto.getRandomValues(aliceAnnouncement);

      // Username only, no message
      const usernameMessage = 'AliceUser:';
      const encodedUserData = new TextEncoder().encode(usernameMessage);

      bobSession.feedIncomingAnnouncement.mockReturnValue({
        announcer_public_keys: alicePk,
        timestamp: Date.now(),
        user_data: encodedUserData,
      } as any);

      vi.spyOn(mockProtocol, 'fetchAnnouncements').mockResolvedValue([
        { counter: '1', data: aliceAnnouncement },
      ]);

      await bobAnnouncementService.fetchAndProcessAnnouncements();

      // Verify contact uses the username
      const bobContact = await db.getContactByOwnerAndUserId(
        bobSession.userIdEncoded,
        aliceSession.userIdEncoded
      );

      expect(bobContact).toBeDefined();
      expect(bobContact?.name).toBe('AliceUser');

      // Verify discussion has undefined message
      const bobDiscussion = await db.getDiscussionByOwnerAndContact(
        bobSession.userIdEncoded,
        aliceSession.userIdEncoded
      );

      expect(bobDiscussion?.announcementMessage).toBeUndefined();
    });

    it('Bob receives announcement without username (no colon in message)', async () => {
      const aliceAnnouncement = new Uint8Array(200);
      crypto.getRandomValues(aliceAnnouncement);

      // New format when user opts out of sharing username, or old client format
      // Just a message without any colon - no username to extract
      const oldFormatMessage = 'Hi, this is an old format message';
      const encodedUserData = new TextEncoder().encode(oldFormatMessage);

      bobSession.feedIncomingAnnouncement.mockReturnValue({
        announcer_public_keys: alicePk,
        timestamp: Date.now(),
        user_data: encodedUserData,
      } as any);

      vi.spyOn(mockProtocol, 'fetchAnnouncements').mockResolvedValue([
        { counter: '1', data: aliceAnnouncement },
      ]);

      await bobAnnouncementService.fetchAndProcessAnnouncements();

      // Verify contact was created with generated temporary name
      const bobContact = await db.getContactByOwnerAndUserId(
        bobSession.userIdEncoded,
        aliceSession.userIdEncoded
      );

      expect(bobContact).toBeDefined();
      expect(bobContact?.name).toMatch(/^New Request \d+$/);

      // Verify discussion has the full message (backwards compatible)
      const bobDiscussion = await db.getDiscussionByOwnerAndContact(
        bobSession.userIdEncoded,
        aliceSession.userIdEncoded
      );

      expect(bobDiscussion?.announcementMessage).toBe(oldFormatMessage);
    });

    it('Bob receives announcement with username containing special characters', async () => {
      const aliceAnnouncement = new Uint8Array(200);
      crypto.getRandomValues(aliceAnnouncement);

      // Username with spaces and special chars, message with colon
      const usernameMessage = 'Alice Smith:Hello: how are you?';
      const encodedUserData = new TextEncoder().encode(usernameMessage);

      bobSession.feedIncomingAnnouncement.mockReturnValue({
        announcer_public_keys: alicePk,
        timestamp: Date.now(),
        user_data: encodedUserData,
      } as any);

      vi.spyOn(mockProtocol, 'fetchAnnouncements').mockResolvedValue([
        { counter: '1', data: aliceAnnouncement },
      ]);

      await bobAnnouncementService.fetchAndProcessAnnouncements();

      // Verify contact uses text before first colon
      const bobContact = await db.getContactByOwnerAndUserId(
        bobSession.userIdEncoded,
        aliceSession.userIdEncoded
      );

      expect(bobContact).toBeDefined();
      expect(bobContact?.name).toBe('Alice Smith');

      // Verify message includes everything after first colon
      const bobDiscussion = await db.getDiscussionByOwnerAndContact(
        bobSession.userIdEncoded,
        aliceSession.userIdEncoded
      );

      expect(bobDiscussion?.announcementMessage).toBe('Hello: how are you?');
    });
  });

  describe('Discussion Initiation Happy Path', () => {
    it('Alice sends announcement and Bob accepts', async () => {
      // Step 1: Alice creates Bob as a contact
      const aliceBobContact: Omit<Contact, 'id'> = {
        ownerUserId: aliceSession.userIdEncoded,
        userId: bobSession.userIdEncoded,
        name: 'Bob',
        publicKeys: bobPk.to_bytes(),
        avatar: undefined,
        isOnline: false,
        lastSeen: new Date(),
        createdAt: new Date(),
      };

      await db.contacts.add(aliceBobContact);

      // Mock Alice's session to return an announcement
      const aliceAnnouncement = new Uint8Array(200);
      crypto.getRandomValues(aliceAnnouncement);
      aliceSession.establishOutgoingSession.mockReturnValue(aliceAnnouncement);

      // Step 2: Alice initializes discussion with Bob
      const { discussionId: aliceDiscussionId } =
        await aliceDiscussionService.initialize(aliceBobContact);

      // Verify Alice's discussion was created with status PENDING
      const aliceDiscussion = await db.discussions.get(aliceDiscussionId);
      expect(aliceDiscussion).toBeDefined();
      expect(aliceDiscussion?.status).toBe(DiscussionStatus.PENDING);
      expect(aliceDiscussion?.direction).toBe('initiated');
      expect(aliceDiscussion?.initiationAnnouncement).toBeDefined();

      // Step 3: Bob fetches announcements (receives Alice's announcement)
      bobSession.feedIncomingAnnouncement.mockReturnValue({
        announcer_public_keys: alicePk,
        timestamp: Date.now(),
        user_data: new Uint8Array(0),
      } as any);

      await bobAnnouncementService.fetchAndProcessAnnouncements();

      // Verify Bob's discussion was created with status PENDING (received)
      const bobDiscussion = await db.getDiscussionByOwnerAndContact(
        bobSession.userIdEncoded,
        aliceSession.userIdEncoded
      );

      expect(bobDiscussion).toBeDefined();
      expect(bobDiscussion?.status).toBe(DiscussionStatus.PENDING);
      expect(bobDiscussion?.direction).toBe('received');

      // Step 5: Bob accepts the discussion request
      if (!bobDiscussion) throw new Error('Bob discussion not found');

      // Mock Bob's session to return an acceptance announcement
      const bobAcceptanceAnnouncement = new Uint8Array(200);
      crypto.getRandomValues(bobAcceptanceAnnouncement);
      bobSession.establishOutgoingSession.mockReturnValue(
        bobAcceptanceAnnouncement
      );

      await bobDiscussionService.accept(bobDiscussion);

      // Verify Bob's discussion is now ACTIVE
      const bobDiscussionAfterAccept = await db.discussions.get(
        bobDiscussion.id!
      );
      expect(bobDiscussionAfterAccept?.status).toBe(DiscussionStatus.ACTIVE);
      expect(bobDiscussionAfterAccept?.initiationAnnouncement).toBeDefined();

      // Step 6: Alice fetches announcements (receives Bob's acceptance)
      aliceSession.feedIncomingAnnouncement.mockReturnValue({
        announcer_public_keys: bobPk,
        timestamp: Date.now(),
        user_data: new Uint8Array(0),
      } as any);

      await aliceAnnouncementService.fetchAndProcessAnnouncements();

      // Verify Alice's discussion is now ACTIVE
      const aliceDiscussionAfterAcceptance =
        await db.discussions.get(aliceDiscussionId);
      expect(aliceDiscussionAfterAcceptance?.status).toBe(
        DiscussionStatus.ACTIVE
      );
    });

    it('Both Alice and Bob send announcement at the same time', async () => {
      // Step 1: Alice creates Bob as a contact
      const aliceBobContact: Omit<Contact, 'id'> = {
        ownerUserId: aliceSession.userIdEncoded,
        userId: bobSession.userIdEncoded,
        name: 'Bob',
        publicKeys: bobPk.to_bytes(),
        avatar: undefined,
        isOnline: false,
        lastSeen: new Date(),
        createdAt: new Date(),
      };

      await db.contacts.add(aliceBobContact);

      // Step 2: Bob creates Alice as a contact
      const bobAliceContact: Omit<Contact, 'id'> = {
        ownerUserId: bobSession.userIdEncoded,
        userId: aliceSession.userIdEncoded,
        name: 'Alice',
        publicKeys: alicePk.to_bytes(),
        avatar: undefined,
        isOnline: false,
        lastSeen: new Date(),
        createdAt: new Date(),
      };

      await db.contacts.add(bobAliceContact);

      // Mock both sessions to return announcements
      const aliceAnnouncement = new Uint8Array(200);
      crypto.getRandomValues(aliceAnnouncement);
      aliceSession.establishOutgoingSession.mockReturnValue(aliceAnnouncement);

      const bobAnnouncement = new Uint8Array(200);
      crypto.getRandomValues(bobAnnouncement);
      bobSession.establishOutgoingSession.mockReturnValue(bobAnnouncement);

      // Step 3: Alice initializes discussion with Bob
      const { discussionId: aliceDiscussionId } =
        await aliceDiscussionService.initialize(aliceBobContact);

      // Step 4: Bob initializes discussion with Alice (simultaneous)
      const { discussionId: bobDiscussionId } =
        await bobDiscussionService.initialize(bobAliceContact);

      // Verify both have PENDING discussions with direction 'initiated'
      const aliceDiscussion = await db.discussions.get(aliceDiscussionId);
      expect(aliceDiscussion?.status).toBe(DiscussionStatus.PENDING);
      expect(aliceDiscussion?.direction).toBe('initiated');

      const bobDiscussion = await db.discussions.get(bobDiscussionId);
      expect(bobDiscussion?.status).toBe(DiscussionStatus.PENDING);
      expect(bobDiscussion?.direction).toBe('initiated');

      // Step 5: Alice fetches announcements (receives Bob's announcement)
      aliceSession.feedIncomingAnnouncement.mockReturnValue({
        announcer_public_keys: bobPk,
        timestamp: Date.now(),
        user_data: new Uint8Array(0),
      } as any);

      await aliceAnnouncementService.fetchAndProcessAnnouncements();

      // Alice should now have an ACTIVE discussion (mutual initiation)
      const aliceDiscussionAfterFetch =
        await db.discussions.get(aliceDiscussionId);
      expect(aliceDiscussionAfterFetch?.status).toBe(DiscussionStatus.ACTIVE);

      // Step 6: Bob fetches announcements (receives Alice's announcement)
      bobSession.feedIncomingAnnouncement.mockReturnValue({
        announcer_public_keys: alicePk,
        timestamp: Date.now(),
        user_data: new Uint8Array(0),
      } as any);

      await bobAnnouncementService.fetchAndProcessAnnouncements();

      // Bob should now have an ACTIVE discussion (mutual initiation)
      const bobDiscussionAfterFetch = await db.discussions.get(bobDiscussionId);
      expect(bobDiscussionAfterFetch?.status).toBe(DiscussionStatus.ACTIVE);
    });
  });

  describe('Discussion Initiation Failures', () => {
    it('Alice tries to send announcement but session manager throws error', async () => {
      // Step 1: Alice creates Bob as a contact
      const aliceBobContact: Omit<Contact, 'id'> = {
        ownerUserId: aliceSession.userIdEncoded,
        userId: bobSession.userIdEncoded,
        name: 'Bob',
        publicKeys: bobPk.to_bytes(),
        avatar: undefined,
        isOnline: false,
        lastSeen: new Date(),
        createdAt: new Date(),
      };

      await db.contacts.add(aliceBobContact);

      // Mock Alice's session to throw an error
      aliceSession.establishOutgoingSession.mockImplementation(() => {
        throw new Error('Session manager error');
      });

      // Step 2: Alice tries to initialize discussion with Bob - should throw
      await expect(
        aliceDiscussionService.initialize(aliceBobContact, undefined)
      ).rejects.toThrow('Discussion initialization failed');

      // Verify no discussion was created
      const discussions = await db.discussions.toArray();
      expect(discussions.length).toBe(0);
    });

    it('Alice signs announcement but network fails, then resend succeeds', async () => {
      // Step 1: Alice creates Bob as a contact
      const aliceBobContact: Omit<Contact, 'id'> = {
        ownerUserId: aliceSession.userIdEncoded,
        userId: bobSession.userIdEncoded,
        name: 'Bob',
        publicKeys: bobPk.to_bytes(),
        avatar: undefined,
        isOnline: false,
        lastSeen: new Date(),
        createdAt: new Date(),
      };

      await db.contacts.add(aliceBobContact);

      // Mock Alice's session to return an announcement
      const aliceAnnouncement = new Uint8Array(200);
      crypto.getRandomValues(aliceAnnouncement);
      aliceSession.establishOutgoingSession.mockReturnValue(aliceAnnouncement);

      // Mock network failure on first attempt
      vi.spyOn(mockProtocol, 'sendAnnouncement')
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValue('counter-123');

      // Step 2: Alice initializes discussion - network fails
      const { discussionId: aliceDiscussionId } =
        await aliceDiscussionService.initialize(aliceBobContact);

      // Verify discussion is in SEND_FAILED status
      let aliceDiscussion = await db.discussions.get(aliceDiscussionId);
      expect(aliceDiscussion?.status).toBe(DiscussionStatus.SEND_FAILED);

      // Wait before retry
      await new Promise(resolve => setTimeout(resolve, 100));

      // Step 3: Resend announcement - should succeed
      aliceSession.peerSessionStatus.mockReturnValue(SessionStatus.Active);
      await aliceAnnouncementService.resendAnnouncements([aliceDiscussion!]);

      aliceDiscussion = await db.discussions.get(aliceDiscussionId);
      expect(aliceDiscussion?.status).toBe(DiscussionStatus.ACTIVE);
    });
  });
});
