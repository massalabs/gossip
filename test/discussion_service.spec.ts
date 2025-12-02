/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db, Contact, DiscussionStatus } from '../src/db';
import {
  initializeDiscussion,
  acceptDiscussionRequest,
  renewDiscussion,
} from '../src/services/discussion';
import { announcementService } from '../src/services/announcement';
import { encodeUserId } from '../src/utils/userId';

// Mock the SessionModule to use our mock implementation
// vi.mock('../wasm/session', async () => {
//   const { MockSessionModule } = await import('../wasm/session_mock');
//   return {
//     SessionModule: MockSessionModule,
//   };
// });

// Mock the userKeys module
// vi.mock('../wasm/userKeys', async () => {
//   const { mockGenerateUserKeys, MockUserPublicKeys, MockUserSecretKeys } = await import('../wasm/session_mock');
//   return {
//     generateUserKeys: mockGenerateUserKeys,
//     UserPublicKeys: MockUserPublicKeys,
//     UserSecretKeys: MockUserSecretKeys,
//   };
// });

// Import mock classes after vi.mock calls (due to hoisting)
import {
  MockSessionModule,
  MockUserPublicKeys,
  MockUserSecretKeys,
  mockGenerateUserKeys,
} from '../src/wasm/mock';
import { SessionModule } from '../src/wasm/session';
import { SessionStatus } from '../src/assets/generated/wasm/gossip_wasm';
import { initSession } from './utils';

describe('Discussion Service', () => {
  // Alice's test data
  let aliceUserId: string;
  let aliceSession: MockSessionModule;
  let alicePk: MockUserPublicKeys;
  let aliceSk: MockUserSecretKeys;

  // Bob's test data
  let bobUserId: string;
  let bobSession: MockSessionModule;
  let bobPk: MockUserPublicKeys;
  let bobSk: MockUserSecretKeys;

  beforeEach(async () => {
    // Database is already cleaned up by setup.ts afterEach hook
    // Just ensure it's open
    if (!db.isOpen()) {
      await db.open();
    }

    // Reset all mocks
    vi.clearAllMocks();

    // Clear mock protocol data to ensure clean state between tests
    const mockProtocol = announcementService.messageProtocol as any;
    if (typeof mockProtocol.clearMockData === 'function') {
      mockProtocol.clearMockData();
    }

    // Suppress expected console.error messages that are part of test scenarios
    // These are expected errors (network failures, session manager errors) that are intentionally tested
    const originalConsoleError = console.error;
    vi.spyOn(console, 'error').mockImplementation((...args) => {
      const message = args.join(' ');
      // Only suppress expected error messages that are part of test scenarios
      if (
        message.includes('Failed to broadcast outgoing session') ||
        message.includes('Failed to establish session with contact') ||
        message.includes('Failed to initialize discussion') ||
        message.includes('Failed to accept pending discussion')
      ) {
        // Suppress these expected errors - they're part of the test scenarios
        return;
      }
      // Let other errors through
      originalConsoleError(...args);
    });

    // Generate Alice's keys
    const aliceKeys = mockGenerateUserKeys();
    aliceUserId = encodeUserId(aliceKeys.publicKeys.user_id);
    alicePk = aliceKeys.publicKeys;
    aliceSk = aliceKeys.secretKeys;

    // Create Alice's session
    aliceSession = new MockSessionModule();

    // Generate Bob's keys
    const bobKeys = mockGenerateUserKeys();
    bobUserId = encodeUserId(bobKeys.publicKeys.user_id);
    bobPk = bobKeys.publicKeys;
    bobSk = bobKeys.secretKeys;

    // Create Bob's session
    bobSession = new MockSessionModule();
  });

  describe('Discussion Initiation Happy Path', () => {
    it('Alice sends announcement and Bob accepts', async () => {
      // Step 1: Alice creates Bob as a contact (like in NewContact.tsx handleSubmit)
      const aliceBobContact: Omit<Contact, 'id'> = {
        ownerUserId: aliceUserId,
        userId: bobUserId,
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
      const { discussionId: aliceDiscussionId } = await initializeDiscussion(
        aliceBobContact,
        alicePk,
        aliceSk,
        aliceSession as unknown as SessionModule,
        aliceUserId
      );

      // Verify Alice's discussion was created with status PENDING
      const aliceDiscussion = await db.discussions.get(aliceDiscussionId);
      expect(aliceDiscussion).toBeDefined();
      expect(aliceDiscussion?.status).toBe(DiscussionStatus.PENDING);
      expect(aliceDiscussion?.direction).toBe('initiated');
      expect(aliceDiscussion?.initiationAnnouncement).toBeDefined();

      // Step 3: Bob fetches announcements (receives Alice's announcement)
      // no need to create Alice contact for Bob because it will be created automatically when Bob fetches Alice's announcements

      bobSession.feedIncomingAnnouncement.mockReturnValue({
        announcer_public_keys: alicePk,
        timestamp: Date.now(),
        user_data: new Uint8Array(0),
      } as any);

      await announcementService.fetchAndProcessAnnouncements(
        bobPk,
        bobSk,
        bobSession as any
      );

      // Verify Bob's discussion was created with status PENDING (received)
      const bobDiscussion = await db.discussions
        .where('[ownerUserId+contactUserId]')
        .equals([bobUserId, aliceUserId])
        .first();

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

      await acceptDiscussionRequest(
        bobDiscussion,
        bobSession as any,
        bobPk,
        bobSk
      );

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

      await announcementService.fetchAndProcessAnnouncements(
        alicePk,
        aliceSk,
        aliceSession as any
      );

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
        ownerUserId: aliceUserId,
        userId: bobUserId,
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
        ownerUserId: bobUserId,
        userId: aliceUserId,
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
      const { discussionId: aliceDiscussionId } = await initializeDiscussion(
        aliceBobContact,
        alicePk,
        aliceSk,
        aliceSession as any,
        aliceUserId
      );

      // Step 4: Bob initializes discussion with Alice (simultaneous)
      const { discussionId: bobDiscussionId } = await initializeDiscussion(
        bobAliceContact,
        bobPk,
        bobSk,
        bobSession as any,
        bobUserId
      );

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

      await announcementService.fetchAndProcessAnnouncements(
        alicePk,
        aliceSk,
        aliceSession as any
      );

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

      await announcementService.fetchAndProcessAnnouncements(
        bobPk,
        bobSk,
        bobSession as any
      );

      // Bob should now have an ACTIVE discussion (mutual initiation)
      const bobDiscussionAfterFetch = await db.discussions.get(bobDiscussionId);
      expect(bobDiscussionAfterFetch?.status).toBe(DiscussionStatus.ACTIVE);
    });
  });

  describe('Discussion Initiation failure', () => {
    it('Alice try to send announcement but session manager error', async () => {
      // Step 1: Alice creates Bob as a contact
      const aliceBobContact: Omit<Contact, 'id'> = {
        ownerUserId: aliceUserId,
        userId: bobUserId,
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
        initializeDiscussion(
          aliceBobContact,
          alicePk,
          aliceSk,
          aliceSession as any,
          aliceUserId
        )
      ).rejects.toThrow('Discussion initialization failed');

      // Verify no discussion was created
      const discussions = await db.discussions.toArray();
      expect(discussions.length).toBe(0);
    });

    it('Alice sign announcement but could not be sent on network. Resend it with success. Same thing happens to Bob acceptation announcement', async () => {
      // Step 1: Alice creates Bob as a contact
      const aliceBobContact: Omit<Contact, 'id'> = {
        ownerUserId: aliceUserId,
        userId: bobUserId,
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
      const mockProtocol = announcementService.messageProtocol;
      vi.spyOn(mockProtocol, 'sendAnnouncement')
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValue('counter-123');

      // Step 2: Alice initializes discussion - network fails
      const { discussionId: aliceDiscussionId } = await initializeDiscussion(
        aliceBobContact,
        alicePk,
        aliceSk,
        aliceSession as any,
        aliceUserId
      );

      // Verify discussion is in SEND_FAILED status
      let aliceDiscussion = await db.discussions.get(aliceDiscussionId);
      expect(aliceDiscussion?.status).toBe(DiscussionStatus.SEND_FAILED);

      // Wait 1 second before retry
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Step 3: Resend announcement - should succeed
      aliceSession.peerSessionStatus.mockReturnValue(SessionStatus.Active);
      await announcementService.resendAnnouncements(
        [aliceDiscussion!],
        aliceSession as any
      );

      aliceDiscussion = await db.discussions.get(aliceDiscussionId);
      expect(aliceDiscussion?.status).toBe(DiscussionStatus.ACTIVE);

      // Step 4: Bob receives Alice's announcement
      vi.spyOn(mockProtocol, 'fetchAnnouncements').mockResolvedValue([
        aliceAnnouncement,
      ]);
      bobSession.feedIncomingAnnouncement.mockReturnValue({
        announcer_public_keys: alicePk,
        timestamp: Date.now(),
        user_data: new Uint8Array(0),
      } as any);

      await announcementService.fetchAndProcessAnnouncements(
        bobPk,
        bobSk,
        bobSession as any
      );

      const bobDiscussion = await db.discussions
        .where('[ownerUserId+contactUserId]')
        .equals([bobUserId, aliceUserId])
        .first();

      expect(bobDiscussion).toBeDefined();
      expect(bobDiscussion?.status).toBe(DiscussionStatus.PENDING);

      // Step 5: Bob accepts - network fails on first attempt
      const bobAcceptanceAnnouncement = new Uint8Array(200);
      crypto.getRandomValues(bobAcceptanceAnnouncement);
      bobSession.establishOutgoingSession.mockReturnValue(
        bobAcceptanceAnnouncement
      );

      vi.spyOn(mockProtocol, 'sendAnnouncement')
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValue('counter-456');

      await acceptDiscussionRequest(
        bobDiscussion!,
        bobSession as any,
        bobPk,
        bobSk
      );

      let bobDiscussionAfterAccept = await db.discussions.get(
        bobDiscussion!.id!
      );
      expect(bobDiscussionAfterAccept?.status).toBe(
        DiscussionStatus.SEND_FAILED
      );

      // Wait 1 second before retry
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Step 6: Resend Bob's acceptance - should succeed
      bobSession.peerSessionStatus.mockReturnValue(SessionStatus.Active);
      await announcementService.resendAnnouncements(
        [bobDiscussionAfterAccept!],
        bobSession as any
      );

      bobDiscussionAfterAccept = await db.discussions.get(bobDiscussion!.id!);
      expect(bobDiscussionAfterAccept?.status).toBe(DiscussionStatus.ACTIVE);

      // step 7 Alice fetch Bob announcement and discussion is ACTIVE

      // Alice fetches incoming announcements (including Bob's acceptance)
      vi.spyOn(mockProtocol, 'fetchAnnouncements').mockResolvedValue([
        bobAcceptanceAnnouncement,
      ]);

      await announcementService.fetchAndProcessAnnouncements(
        alicePk,
        aliceSk,
        aliceSession as any
      );

      const aliceDiscussionAfterBobAccept = await db.discussions
        .where('[ownerUserId+contactUserId]')
        .equals([aliceUserId, bobUserId])
        .first();

      expect(aliceDiscussionAfterBobAccept).toBeDefined();
      expect(aliceDiscussionAfterBobAccept?.status).toBe(
        DiscussionStatus.ACTIVE
      );
    });

    it('Alice sign announcement but could not be sent. Resend fails 3 times and success the 4th time. Bob accept without issue', async () => {
      // Step 1: Alice creates Bob as a contact
      const aliceBobContact: Omit<Contact, 'id'> = {
        ownerUserId: aliceUserId,
        userId: bobUserId,
        name: 'Bob',
        publicKeys: bobPk.to_bytes(),
        avatar: undefined,
        isOnline: false,
        lastSeen: new Date(),
        createdAt: new Date(),
      };

      await db.contacts.add(aliceBobContact);

      // Mock Alice's session
      const aliceAnnouncement = new Uint8Array(200);
      crypto.getRandomValues(aliceAnnouncement);
      aliceSession.establishOutgoingSession.mockReturnValue(aliceAnnouncement);

      // Mock network failure 4 times, then success
      const mockProtocol = announcementService.messageProtocol;
      vi.spyOn(mockProtocol, 'sendAnnouncement')
        .mockRejectedValueOnce(new Error('Network error 1'))
        .mockRejectedValueOnce(new Error('Network error 2'))
        .mockRejectedValueOnce(new Error('Network error 3'))
        .mockRejectedValueOnce(new Error('Network error 4'))
        .mockResolvedValue('counter-123');

      // Step 2: Alice initializes discussion - network fails
      const { discussionId: aliceDiscussionId } = await initializeDiscussion(
        aliceBobContact,
        alicePk,
        aliceSk,
        aliceSession as any,
        aliceUserId
      );

      let aliceDiscussion = await db.discussions.get(aliceDiscussionId);
      expect(aliceDiscussion?.status).toBe(DiscussionStatus.SEND_FAILED);

      // Step 3: Retry 3 times with failures
      aliceSession.peerSessionStatus.mockReturnValue(SessionStatus.Active);
      for (let i = 0; i < 3; i++) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        await announcementService.resendAnnouncements(
          [aliceDiscussion!],
          aliceSession as any
        );
        aliceDiscussion = await db.discussions.get(aliceDiscussionId);
        expect(aliceDiscussion?.status).toBe(DiscussionStatus.SEND_FAILED);
      }

      // Step 4: 4th retry succeeds
      await new Promise(resolve => setTimeout(resolve, 1000));
      await announcementService.resendAnnouncements(
        [aliceDiscussion!],
        aliceSession as any
      );
      aliceDiscussion = await db.discussions.get(aliceDiscussionId);
      expect(aliceDiscussion?.status).toBe(DiscussionStatus.ACTIVE);

      // Step 5: Bob receives and accepts without issue
      vi.spyOn(mockProtocol, 'fetchAnnouncements').mockResolvedValue([
        aliceAnnouncement,
      ]);

      bobSession.feedIncomingAnnouncement.mockReturnValue({
        announcer_public_keys: alicePk,
        timestamp: Date.now(),
        user_data: new Uint8Array(0),
      } as any);

      await announcementService.fetchAndProcessAnnouncements(
        bobPk,
        bobSk,
        bobSession as any
      );

      const bobDiscussion = await db.discussions
        .where('[ownerUserId+contactUserId]')
        .equals([bobUserId, aliceUserId])
        .first();

      const bobAcceptanceAnnouncement = new Uint8Array(200);
      crypto.getRandomValues(bobAcceptanceAnnouncement);
      bobSession.establishOutgoingSession.mockReturnValue(
        bobAcceptanceAnnouncement
      );

      vi.spyOn(mockProtocol, 'sendAnnouncement').mockResolvedValue(
        'counter-456'
      );

      await acceptDiscussionRequest(
        bobDiscussion!,
        bobSession as any,
        bobPk,
        bobSk
      );

      const bobDiscussionAfterAccept = await db.discussions.get(
        bobDiscussion!.id!
      );
      expect(bobDiscussionAfterAccept?.status).toBe(DiscussionStatus.ACTIVE);
    });

    it('Alice sign announcement but could not be sent. Resend fails too many times and session is broken. Renew session and resend. Bob accept.', async () => {
      // Step 1: Alice creates Bob as a contact
      const aliceBobContact: Omit<Contact, 'id'> = {
        ownerUserId: aliceUserId,
        userId: bobUserId,
        name: 'Bob',
        publicKeys: bobPk.to_bytes(),
        avatar: undefined,
        isOnline: false,
        lastSeen: new Date(),
        createdAt: new Date(),
      };

      await db.contacts.add(aliceBobContact);

      // Mock Alice's session
      const aliceAnnouncement = new Uint8Array(200);
      crypto.getRandomValues(aliceAnnouncement);
      aliceSession.establishOutgoingSession.mockReturnValue(aliceAnnouncement);

      // Mock persistent network failure
      const mockProtocol = announcementService.messageProtocol;
      const sendAnnouncementSpy = vi
        .spyOn(mockProtocol, 'sendAnnouncement')
        .mockRejectedValue(new Error('Network error'));

      // Step 2: Alice initializes discussion - network fails
      const { discussionId: aliceDiscussionId } = await initializeDiscussion(
        aliceBobContact,
        alicePk,
        aliceSk,
        aliceSession as any,
        aliceUserId
      );

      let aliceDiscussion = await db.discussions.get(aliceDiscussionId);
      expect(aliceDiscussion?.status).toBe(DiscussionStatus.SEND_FAILED);

      // Step 3: Mock time passing (more than ONE_HOUR_MS = 60 * 60 * 1000)
      const oneHourAgo = new Date(Date.now() - 61 * 60 * 1000); // 61 minutes ago
      await db.discussions.update(aliceDiscussionId, { updatedAt: oneHourAgo });

      // Step 4: Resend - should mark as BROKEN
      await announcementService.resendAnnouncements(
        [{ ...aliceDiscussion!, updatedAt: oneHourAgo }],
        aliceSession as any
      );

      aliceDiscussion = await db.discussions.get(aliceDiscussionId);
      expect(aliceDiscussion?.status).toBe(DiscussionStatus.BROKEN);
      expect(aliceDiscussion?.initiationAnnouncement).toBeUndefined();

      // Step 5: Renew session - clear previous mock and set success
      const newAliceAnnouncement = new Uint8Array(200);
      crypto.getRandomValues(newAliceAnnouncement);
      aliceSession.establishOutgoingSession.mockReturnValue(
        newAliceAnnouncement
      );
      sendAnnouncementSpy.mockClear();
      sendAnnouncementSpy.mockResolvedValue('counter-123');
      aliceSession.peerSessionStatus.mockReturnValue(
        SessionStatus.SelfRequested
      );
      await renewDiscussion(
        aliceUserId,
        bobUserId,
        aliceSession as any,
        alicePk,
        aliceSk
      );

      aliceDiscussion = await db.discussions.get(aliceDiscussionId);
      expect(aliceDiscussion?.status).toBe(DiscussionStatus.PENDING); // PENDING until network confirms
      expect(aliceDiscussion?.direction).toBe('initiated');

      // Step 6: Bob receives and accepts
      vi.spyOn(mockProtocol, 'fetchAnnouncements').mockResolvedValue([
        newAliceAnnouncement,
      ]);

      bobSession.feedIncomingAnnouncement.mockReturnValue({
        announcer_public_keys: alicePk,
        timestamp: Date.now(),
        user_data: new Uint8Array(0),
      } as any);

      await announcementService.fetchAndProcessAnnouncements(
        bobPk,
        bobSk,
        bobSession as any
      );

      const bobDiscussion = await db.discussions
        .where('[ownerUserId+contactUserId]')
        .equals([bobUserId, aliceUserId])
        .first();

      const bobAcceptanceAnnouncement = new Uint8Array(200);
      crypto.getRandomValues(bobAcceptanceAnnouncement);
      bobSession.establishOutgoingSession.mockReturnValue(
        bobAcceptanceAnnouncement
      );

      await acceptDiscussionRequest(
        bobDiscussion!,
        bobSession as any,
        bobPk,
        bobSk
      );

      const bobDiscussionAfterAccept = await db.discussions.get(
        bobDiscussion!.id!
      );
      expect(bobDiscussionAfterAccept?.status).toBe(DiscussionStatus.ACTIVE);

      // Step 7: Alice fetches Bob's announcement and discussion is ACTIVE
      vi.spyOn(mockProtocol, 'fetchAnnouncements').mockResolvedValue([
        bobAcceptanceAnnouncement,
      ]);
      aliceSession.feedIncomingAnnouncement.mockReturnValue({
        announcer_public_keys: bobPk,
        timestamp: Date.now(),
        user_data: new Uint8Array(0),
      } as any);

      await announcementService.fetchAndProcessAnnouncements(
        alicePk,
        aliceSk,
        aliceSession as any
      );

      const aliceDiscussionAfterBobAccept = await db.discussions
        .where('[ownerUserId+contactUserId]')
        .equals([aliceUserId, bobUserId])
        .first();

      expect(aliceDiscussionAfterBobAccept).toBeDefined();
      expect(aliceDiscussionAfterBobAccept?.status).toBe(
        DiscussionStatus.ACTIVE
      );
    });

    it('Alice send announcement, bob accept but get session manager error. Retry, sign announcement but could not be sent on network until session broke. Renew session and resend with success', async () => {
      // Step 1: Alice creates Bob and sends announcement successfully
      const aliceBobContact: Omit<Contact, 'id'> = {
        ownerUserId: aliceUserId,
        userId: bobUserId,
        name: 'Bob',
        publicKeys: bobPk.to_bytes(),
        avatar: undefined,
        isOnline: false,
        lastSeen: new Date(),
        createdAt: new Date(),
      };

      await db.contacts.add(aliceBobContact);

      const aliceAnnouncement = new Uint8Array(200);
      crypto.getRandomValues(aliceAnnouncement);
      aliceSession.establishOutgoingSession.mockReturnValue(aliceAnnouncement);

      const mockProtocol = announcementService.messageProtocol;
      vi.spyOn(mockProtocol, 'sendAnnouncement').mockResolvedValue(
        'counter-123'
      );

      await initializeDiscussion(
        aliceBobContact,
        alicePk,
        aliceSk,
        aliceSession as any,
        aliceUserId
      );

      // Step 2: Bob receives Alice's announcement
      vi.spyOn(mockProtocol, 'fetchAnnouncements').mockResolvedValue([
        aliceAnnouncement,
      ]);

      bobSession.feedIncomingAnnouncement.mockReturnValue({
        announcer_public_keys: alicePk,
        timestamp: Date.now(),
        user_data: new Uint8Array(0),
      } as any);

      await announcementService.fetchAndProcessAnnouncements(
        bobPk,
        bobSk,
        bobSession as any
      );

      const bobDiscussion = await db.discussions
        .where('[ownerUserId+contactUserId]')
        .equals([bobUserId, aliceUserId])
        .first();

      // Step 3: Bob tries to accept but session manager error
      bobSession.establishOutgoingSession.mockImplementation(() => {
        throw new Error('Session manager error');
      });

      await expect(
        acceptDiscussionRequest(bobDiscussion!, bobSession as any, bobPk, bobSk)
      ).rejects.toThrow('Failed to accept pending discussion');

      // Step 4: Bob retries - session works but network fails
      const bobAcceptanceAnnouncement = new Uint8Array(200);
      crypto.getRandomValues(bobAcceptanceAnnouncement);
      bobSession.establishOutgoingSession.mockReturnValue(
        bobAcceptanceAnnouncement
      );
      vi.spyOn(mockProtocol, 'sendAnnouncement').mockRejectedValue(
        new Error('Network error')
      );

      await acceptDiscussionRequest(
        bobDiscussion!,
        bobSession as any,
        bobPk,
        bobSk
      );

      let bobDiscussionAfterAccept = await db.discussions.get(
        bobDiscussion!.id!
      );
      expect(bobDiscussionAfterAccept?.status).toBe(
        DiscussionStatus.SEND_FAILED
      );

      // Step 5: Mock time passing to break the session
      const oneHourAgo = new Date(Date.now() - 61 * 60 * 1000);
      await db.discussions.update(bobDiscussion!.id!, {
        updatedAt: oneHourAgo,
      });

      await announcementService.resendAnnouncements(
        [{ ...bobDiscussionAfterAccept!, updatedAt: oneHourAgo }],
        bobSession as any
      );

      bobDiscussionAfterAccept = await db.discussions.get(bobDiscussion!.id!);
      expect(bobDiscussionAfterAccept?.status).toBe(DiscussionStatus.BROKEN);

      // Step 6: Renew session and resend with success
      const newBobAnnouncement = new Uint8Array(200);
      crypto.getRandomValues(newBobAnnouncement);
      bobSession.establishOutgoingSession.mockReturnValue(newBobAnnouncement);
      vi.spyOn(mockProtocol, 'sendAnnouncement')
        .mockClear()
        .mockResolvedValue('counter-456');

      await renewDiscussion(
        bobUserId,
        aliceUserId,
        bobSession as any,
        bobPk,
        bobSk
      );

      bobDiscussionAfterAccept = await db.discussions.get(bobDiscussion!.id!);
      expect(bobDiscussionAfterAccept?.status).toBe(DiscussionStatus.PENDING); // PENDING until Alice responds

      // Step 7: Alice fetches Bob's announcement and discussion is ACTIVE
      vi.spyOn(mockProtocol, 'fetchAnnouncements').mockResolvedValue([
        bobAcceptanceAnnouncement,
      ]);
      aliceSession.feedIncomingAnnouncement.mockReturnValue({
        announcer_public_keys: bobPk,
        timestamp: Date.now(),
        user_data: new Uint8Array(0),
      } as any);

      await announcementService.fetchAndProcessAnnouncements(
        alicePk,
        aliceSk,
        aliceSession as any
      );

      const aliceDiscussionAfterBobAccept = await db.discussions
        .where('[ownerUserId+contactUserId]')
        .equals([aliceUserId, bobUserId])
        .first();

      expect(aliceDiscussionAfterBobAccept).toBeDefined();
      expect(aliceDiscussionAfterBobAccept?.status).toBe(
        DiscussionStatus.ACTIVE
      );
    });

    it("Alice and Bob both send announcements at the same time. Both have network issue and resend. Alice receive Bob's announcement while resending", async () => {
      /* Step 1: Both create contacts */
      const aliceBobContact: Omit<Contact, 'id'> = {
        ownerUserId: aliceUserId,
        userId: bobUserId,
        name: 'Bob',
        publicKeys: bobPk.to_bytes(),
        avatar: undefined,
        isOnline: false,
        lastSeen: new Date(),
        createdAt: new Date(),
      };

      const bobAliceContact: Omit<Contact, 'id'> = {
        ownerUserId: bobUserId,
        userId: aliceUserId,
        name: 'Alice',
        publicKeys: alicePk.to_bytes(),
        avatar: undefined,
        isOnline: false,
        lastSeen: new Date(),
        createdAt: new Date(),
      };

      await db.contacts.add(aliceBobContact);
      await db.contacts.add(bobAliceContact);

      /* Step 2: Both try to send announcements - network fails */
      const aliceAnnouncement = new Uint8Array(200);
      crypto.getRandomValues(aliceAnnouncement);
      aliceSession.establishOutgoingSession.mockReturnValue(aliceAnnouncement);

      const bobAnnouncement = new Uint8Array(200);
      crypto.getRandomValues(bobAnnouncement);
      bobSession.establishOutgoingSession.mockReturnValue(bobAnnouncement);

      const mockProtocol = announcementService.messageProtocol;
      vi.spyOn(mockProtocol, 'sendAnnouncement')
        .mockRejectedValueOnce(new Error('Network error'))
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValue('counter-123');

      const { discussionId: aliceDiscussionId } = await initializeDiscussion(
        aliceBobContact,
        alicePk,
        aliceSk,
        aliceSession as any,
        aliceUserId
      );

      const { discussionId: bobDiscussionId } = await initializeDiscussion(
        bobAliceContact,
        bobPk,
        bobSk,
        bobSession as any,
        bobUserId
      );

      let aliceDiscussion = await db.discussions.get(aliceDiscussionId);
      let bobDiscussion = await db.discussions.get(bobDiscussionId);

      expect(aliceDiscussion?.status).toBe(DiscussionStatus.SEND_FAILED);
      expect(bobDiscussion?.status).toBe(DiscussionStatus.SEND_FAILED);

      /* Step 3: Wait and resend - Bob's succeeds */
      await new Promise(resolve => setTimeout(resolve, 1000));

      bobSession.peerSessionStatus.mockReturnValue(SessionStatus.SelfRequested);
      await announcementService.resendAnnouncements(
        [bobDiscussion!],
        bobSession as any
      );

      bobDiscussion = await db.discussions.get(bobDiscussionId);

      expect(bobDiscussion?.status).toBe(DiscussionStatus.PENDING);

      /* Step 4: Alice receives Bob's announcement before she resend */
      vi.spyOn(mockProtocol, 'fetchAnnouncements').mockResolvedValue([
        bobAnnouncement,
      ]);

      aliceSession.feedIncomingAnnouncement.mockReturnValue({
        announcer_public_keys: bobPk,
        timestamp: Date.now(),
        user_data: new Uint8Array(0),
      } as any);

      await announcementService.fetchAndProcessAnnouncements(
        alicePk,
        aliceSk,
        aliceSession as any
      );

      aliceDiscussion = await db.discussions.get(aliceDiscussionId);
      expect(aliceDiscussion?.status).toBe(DiscussionStatus.SEND_FAILED);

      /* Step 5: Alice resend her announcement */
      aliceSession.peerSessionStatus.mockReturnValue(SessionStatus.Active);
      await announcementService.resendAnnouncements(
        [aliceDiscussion!],
        aliceSession as any
      );

      aliceDiscussion = await db.discussions.get(aliceDiscussionId);
      expect(aliceDiscussion?.status).toBe(DiscussionStatus.ACTIVE);

      /* Step 6: Bob fetches Alice's announcement and discussion is ACTIVE */
      vi.spyOn(mockProtocol, 'fetchAnnouncements').mockResolvedValue([
        aliceAnnouncement,
      ]);
      bobSession.feedIncomingAnnouncement.mockReturnValue({
        announcer_public_keys: alicePk,
        timestamp: Date.now(),
        user_data: new Uint8Array(0),
      } as any);

      await announcementService.fetchAndProcessAnnouncements(
        bobPk,
        bobSk,
        bobSession as any
      );

      const bobDiscussionAfterAliceResend =
        await db.discussions.get(bobDiscussionId);
      expect(bobDiscussionAfterAliceResend?.status).toBe(
        DiscussionStatus.ACTIVE
      );
    });

    it("Alice and Bob both send announcement at same time. Bob session is broken because of too much resend. Bob receive Alice's announcement while session is broken.", async () => {
      // Step 1: Both create contacts
      const aliceBobContact: Omit<Contact, 'id'> = {
        ownerUserId: aliceUserId,
        userId: bobUserId,
        name: 'Bob',
        publicKeys: bobPk.to_bytes(),
        avatar: undefined,
        isOnline: false,
        lastSeen: new Date(),
        createdAt: new Date(),
      };

      const bobAliceContact: Omit<Contact, 'id'> = {
        ownerUserId: bobUserId,
        userId: aliceUserId,
        name: 'Alice',
        publicKeys: alicePk.to_bytes(),
        avatar: undefined,
        isOnline: false,
        lastSeen: new Date(),
        createdAt: new Date(),
      };

      await db.contacts.add(aliceBobContact);
      await db.contacts.add(bobAliceContact);

      // Step 2: Both send announcements - Alice succeeds, Bob fails
      const aliceAnnouncement = new Uint8Array(200);
      crypto.getRandomValues(aliceAnnouncement);
      aliceSession.establishOutgoingSession.mockReturnValue(aliceAnnouncement);

      const bobAnnouncement = new Uint8Array(200);
      crypto.getRandomValues(bobAnnouncement);
      bobSession.establishOutgoingSession.mockReturnValue(bobAnnouncement);

      const mockProtocol = announcementService.messageProtocol;
      vi.spyOn(mockProtocol, 'sendAnnouncement')
        .mockResolvedValueOnce('counter-123') // Alice succeeds
        .mockRejectedValue(new Error('Network error')); // Bob fails

      const { discussionId: aliceDiscussionId } = await initializeDiscussion(
        aliceBobContact,
        alicePk,
        aliceSk,
        aliceSession as any,
        aliceUserId
      );

      const { discussionId: bobDiscussionId } = await initializeDiscussion(
        bobAliceContact,
        bobPk,
        bobSk,
        bobSession as any,
        bobUserId
      );

      const aliceDiscussion = await db.discussions.get(aliceDiscussionId);
      let bobDiscussion = await db.discussions.get(bobDiscussionId);

      expect(aliceDiscussion?.status).toBe(DiscussionStatus.PENDING); // PENDING until Bob responds
      expect(bobDiscussion?.status).toBe(DiscussionStatus.SEND_FAILED);

      // Step 3: Mock time passing for Bob's discussion to break
      const oneHourAgo = new Date(Date.now() - 61 * 60 * 1000);
      await db.discussions.update(bobDiscussionId, { updatedAt: oneHourAgo });

      await announcementService.resendAnnouncements(
        [{ ...bobDiscussion!, updatedAt: oneHourAgo }],
        bobSession as any
      );

      bobDiscussion = await db.discussions.get(bobDiscussionId);
      expect(bobDiscussion?.status).toBe(DiscussionStatus.BROKEN);

      // Step 4: Bob receives Alice's announcement while his session is broken
      vi.spyOn(mockProtocol, 'fetchAnnouncements').mockResolvedValue([
        aliceAnnouncement,
      ]);

      bobSession.feedIncomingAnnouncement.mockReturnValue({
        announcer_public_keys: alicePk,
        timestamp: Date.now(),
        user_data: new Uint8Array(0),
      } as any);

      await announcementService.fetchAndProcessAnnouncements(
        bobPk,
        bobSk,
        bobSession as any
      );

      // Bob's broken discussion should remain BROKEN until it is reinitialized
      bobDiscussion = await db.discussions.get(bobDiscussionId);
      expect(bobDiscussion?.status).toBe(DiscussionStatus.BROKEN);

      /* Step 5: Bob renew his announcement with success */
      bobSession.peerSessionStatus.mockReturnValue(SessionStatus.Active);
      bobSession.establishOutgoingSession.mockReturnValue(bobAnnouncement);
      vi.spyOn(mockProtocol, 'sendAnnouncement').mockResolvedValue(
        'counter-456'
      );

      await renewDiscussion(
        bobUserId,
        aliceUserId,
        bobSession as any,
        bobPk,
        bobSk
      );

      bobDiscussion = await db.discussions.get(bobDiscussionId);
      expect(bobDiscussion?.status).toBe(DiscussionStatus.ACTIVE);
    });

    it('Alice and Bob setup a discussion with success; Alice discussion is broken; renew first fails, second fails with network, third succeeds; Bob receives announcement', async () => {
      /* Step 1: Alice and Bob have contacts and sessions set up */
      const { aliceDiscussionId, bobDiscussionId } = await initSession(
        alicePk,
        aliceSk,
        bobPk,
        bobSk,
        db,
        aliceSession,
        bobSession
      );

      /* Step 2: Alice's discussion becomes BROKEN */
      db.discussions.update(aliceDiscussionId, {
        status: DiscussionStatus.BROKEN,
      });

      /* Step 3: First attempt to renew - session manager error */
      aliceSession.establishOutgoingSession.mockRejectedValueOnce(
        new Error('Session manager error')
      );
      await expect(
        renewDiscussion(
          aliceUserId,
          bobUserId,
          aliceSession as any,
          alicePk,
          aliceSk
        )
      ).rejects.toThrow();
      let aliceDiscussion = await db.discussions.get(aliceDiscussionId);
      expect(aliceDiscussion?.status).toBe(DiscussionStatus.BROKEN); // Still broken

      // Step 4: Second attempt - network failure, goes to SEND_FAILED
      const mockProtocol = announcementService.messageProtocol;
      vi.spyOn(mockProtocol, 'sendAnnouncement').mockRejectedValueOnce(
        new Error('Network down')
      );

      await renewDiscussion(
        aliceUserId,
        bobUserId,
        aliceSession as any,
        alicePk,
        aliceSk
      );

      aliceDiscussion = await db.discussions.get(aliceDiscussionId);
      expect(aliceDiscussion?.status).toBe(DiscussionStatus.SEND_FAILED);

      // Step 5: Third attempt - success, discussion becomes ACTIVE
      const renewedAnnouncement = new Uint8Array(200);
      crypto.getRandomValues(renewedAnnouncement);
      aliceSession.establishOutgoingSession.mockReturnValue(
        renewedAnnouncement
      );

      vi.spyOn(mockProtocol, 'sendAnnouncement').mockResolvedValueOnce(
        'counter-success'
      );
      aliceSession.peerSessionStatus.mockReturnValue(SessionStatus.Active);

      await renewDiscussion(
        aliceUserId,
        bobUserId,
        aliceSession as any,
        alicePk,
        aliceSk
      );

      aliceDiscussion = await db.discussions.get(aliceDiscussionId);
      expect(aliceDiscussion?.status).toBe(DiscussionStatus.ACTIVE);

      // Step 6: Bob receives Alice's renewed announcement
      vi.spyOn(mockProtocol, 'fetchAnnouncements').mockResolvedValue([
        renewedAnnouncement as any,
      ]);

      bobSession.feedIncomingAnnouncement.mockReturnValue({
        announcer_public_keys: alicePk,
        timestamp: Date.now(),
        user_data: new Uint8Array(0),
      } as any);

      await announcementService.fetchAndProcessAnnouncements(
        bobPk,
        bobSk,
        bobSession as any
      );

      const bobDiscussion = await db.discussions.get(bobDiscussionId);
      expect(bobDiscussion?.status === DiscussionStatus.ACTIVE).toBeTruthy();
    });
  });
});
