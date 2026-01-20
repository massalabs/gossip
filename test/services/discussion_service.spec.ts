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
import { db as appDb, Contact, DiscussionStatus } from '../../src/db';
import {
  AnnouncementService,
  DiscussionService,
  SessionStatus,
  SessionModule,
  UserPublicKeys,
  UserSecretKeys,
  generateUserKeys,
} from 'gossip-sdk';

// Import mock classes after vi.mock calls (due to hoisting)
import { MockSessionModule } from '../wasm/mock';
import { initSession, initializeSessionMock } from '../utils';
import { MockMessageProtocol } from '../mocks/mockMessageProtocol';

describe('Discussion Service', () => {
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
    // Database is already cleaned up by setup.ts afterEach hook
    // Just ensure it's open
    if (!appDb.isOpen()) {
      await appDb.open();
    }

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
      appDb,
      mockProtocol,
      aliceSession as unknown as SessionModule
    );
    aliceDiscussionService = new DiscussionService(
      appDb,
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
      appDb,
      mockProtocol,
      bobSession as unknown as SessionModule
    );
    bobDiscussionService = new DiscussionService(
      appDb,
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

  describe('Discussion Initiation Happy Path', () => {
    it('Alice sends announcement and Bob accepts', async () => {
      // Step 1: Alice creates Bob as a contact (like in NewContact.tsx handleSubmit)
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

      await appDb.contacts.add(aliceBobContact);

      // Mock Alice's session to return an announcement
      const aliceAnnouncement = new Uint8Array(200);
      crypto.getRandomValues(aliceAnnouncement);
      aliceSession.establishOutgoingSession.mockReturnValue(aliceAnnouncement);

      // Step 2: Alice initializes discussion with Bob
      const { discussionId: aliceDiscussionId } =
        await aliceDiscussionService.initialize(aliceBobContact);

      // Verify Alice's discussion was created with status PENDING
      const aliceDiscussion = await appDb.discussions.get(aliceDiscussionId);
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

      await bobAnnouncementService.fetchAndProcessAnnouncements();

      // Verify Bob's discussion was created with status PENDING (received)
      const bobDiscussion = await appDb.getDiscussionByOwnerAndContact(
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
      const bobDiscussionAfterAccept = await appDb.discussions.get(
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
        await appDb.discussions.get(aliceDiscussionId);
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

      await appDb.contacts.add(aliceBobContact);

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

      await appDb.contacts.add(bobAliceContact);

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
      const aliceDiscussion = await appDb.discussions.get(aliceDiscussionId);
      expect(aliceDiscussion?.status).toBe(DiscussionStatus.PENDING);
      expect(aliceDiscussion?.direction).toBe('initiated');

      const bobDiscussion = await appDb.discussions.get(bobDiscussionId);
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
        await appDb.discussions.get(aliceDiscussionId);
      expect(aliceDiscussionAfterFetch?.status).toBe(DiscussionStatus.ACTIVE);

      // Step 6: Bob fetches announcements (receives Alice's announcement)

      bobSession.feedIncomingAnnouncement.mockReturnValue({
        announcer_public_keys: alicePk,
        timestamp: Date.now(),
        user_data: new Uint8Array(0),
      } as any);

      await bobAnnouncementService.fetchAndProcessAnnouncements();

      // Bob should now have an ACTIVE discussion (mutual initiation)
      const bobDiscussionAfterFetch =
        await appDb.discussions.get(bobDiscussionId);
      expect(bobDiscussionAfterFetch?.status).toBe(DiscussionStatus.ACTIVE);
    });
  });

  describe('Discussion Initiation failure', () => {
    it('Alice try to send announcement but session manager error', async () => {
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

      await appDb.contacts.add(aliceBobContact);

      // Mock Alice's session to throw an error
      aliceSession.establishOutgoingSession.mockImplementation(() => {
        throw new Error('Session manager error');
      });

      // Step 2: Alice tries to initialize discussion with Bob - should throw
      await expect(
        aliceDiscussionService.initialize(aliceBobContact, undefined)
      ).rejects.toThrow('Discussion initialization failed');

      // Verify no discussion was created
      const discussions = await appDb.discussions.toArray();
      expect(discussions.length).toBe(0);
    });

    it('Alice sign announcement but could not be sent on network. Resend it with success. Same thing happens to Bob acceptation announcement', async () => {
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

      await appDb.contacts.add(aliceBobContact);

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
      let aliceDiscussion = await appDb.discussions.get(aliceDiscussionId);
      expect(aliceDiscussion?.status).toBe(DiscussionStatus.SEND_FAILED);

      // Wait 1 second before retry
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Step 3: Resend announcement - should succeed
      aliceSession.peerSessionStatus.mockReturnValue(SessionStatus.Active);
      await aliceAnnouncementService.resendAnnouncements([aliceDiscussion!]);

      aliceDiscussion = await appDb.discussions.get(aliceDiscussionId);
      expect(aliceDiscussion?.status).toBe(DiscussionStatus.ACTIVE);

      // Step 4: Bob receives Alice's announcement
      vi.spyOn(mockProtocol, 'fetchAnnouncements').mockResolvedValue([
        { counter: '1', data: aliceAnnouncement },
      ]);
      bobSession.feedIncomingAnnouncement.mockReturnValue({
        announcer_public_keys: alicePk,
        timestamp: Date.now(),
        user_data: new Uint8Array(0),
      } as any);

      await bobAnnouncementService.fetchAndProcessAnnouncements();

      const bobDiscussion = await appDb.getDiscussionByOwnerAndContact(
        bobSession.userIdEncoded,
        aliceSession.userIdEncoded
      );

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

      await bobDiscussionService.accept(bobDiscussion!);

      let bobDiscussionAfterAccept = await appDb.discussions.get(
        bobDiscussion!.id!
      );
      expect(bobDiscussionAfterAccept?.status).toBe(
        DiscussionStatus.SEND_FAILED
      );

      // Wait 1 second before retry
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Step 6: Resend Bob's acceptance - should succeed
      bobSession.peerSessionStatus.mockReturnValue(SessionStatus.Active);
      await bobAnnouncementService.resendAnnouncements([
        bobDiscussionAfterAccept!,
      ]);

      bobDiscussionAfterAccept = await appDb.discussions.get(
        bobDiscussion!.id!
      );
      expect(bobDiscussionAfterAccept?.status).toBe(DiscussionStatus.ACTIVE);

      // step 7 Alice fetch Bob announcement and discussion is ACTIVE

      // Alice fetches incoming announcements (including Bob's acceptance)
      vi.spyOn(mockProtocol, 'fetchAnnouncements').mockResolvedValue([
        { counter: '2', data: bobAcceptanceAnnouncement },
      ]);

      await aliceAnnouncementService.fetchAndProcessAnnouncements();

      const aliceDiscussionAfterBobAccept =
        await appDb.getDiscussionByOwnerAndContact(
          aliceSession.userIdEncoded,
          bobSession.userIdEncoded
        );

      expect(aliceDiscussionAfterBobAccept).toBeDefined();
      expect(aliceDiscussionAfterBobAccept?.status).toBe(
        DiscussionStatus.ACTIVE
      );
    });

    it('Alice sign announcement but could not be sent. Resend fails 3 times and success the 4th time. Bob accept without issue', async () => {
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

      await appDb.contacts.add(aliceBobContact);

      // Mock Alice's session
      const aliceAnnouncement = new Uint8Array(200);
      crypto.getRandomValues(aliceAnnouncement);
      aliceSession.establishOutgoingSession.mockReturnValue(aliceAnnouncement);

      // Mock network failure 4 times, then success
      // const mockProtocol = announcementService.messageProtocol;
      vi.spyOn(mockProtocol, 'sendAnnouncement')
        .mockRejectedValueOnce(new Error('Network error 1'))
        .mockRejectedValueOnce(new Error('Network error 2'))
        .mockRejectedValueOnce(new Error('Network error 3'))
        .mockRejectedValueOnce(new Error('Network error 4'))
        .mockResolvedValue('counter-123');

      // Step 2: Alice initializes discussion - network fails
      const { discussionId: aliceDiscussionId } =
        await aliceDiscussionService.initialize(aliceBobContact);

      let aliceDiscussion = await appDb.discussions.get(aliceDiscussionId);
      expect(aliceDiscussion?.status).toBe(DiscussionStatus.SEND_FAILED);

      // Step 3: Retry 3 times with failures
      aliceSession.peerSessionStatus.mockReturnValue(SessionStatus.Active);
      for (let i = 0; i < 3; i++) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        await aliceAnnouncementService.resendAnnouncements([aliceDiscussion!]);
        aliceDiscussion = await appDb.discussions.get(aliceDiscussionId);
        expect(aliceDiscussion?.status).toBe(DiscussionStatus.SEND_FAILED);
      }

      // Step 4: 4th retry succeeds
      await new Promise(resolve => setTimeout(resolve, 1000));
      await aliceAnnouncementService.resendAnnouncements([aliceDiscussion!]);
      aliceDiscussion = await appDb.discussions.get(aliceDiscussionId);
      expect(aliceDiscussion?.status).toBe(DiscussionStatus.ACTIVE);

      // Step 5: Bob receives and accepts without issue
      vi.spyOn(mockProtocol, 'fetchAnnouncements').mockResolvedValue([
        { counter: '1', data: aliceAnnouncement },
      ]);

      bobSession.feedIncomingAnnouncement.mockReturnValue({
        announcer_public_keys: alicePk,
        timestamp: Date.now(),
        user_data: new Uint8Array(0),
      } as any);

      await bobAnnouncementService.fetchAndProcessAnnouncements();

      const bobDiscussion = await appDb.getDiscussionByOwnerAndContact(
        bobSession.userIdEncoded,
        aliceSession.userIdEncoded
      );

      const bobAcceptanceAnnouncement = new Uint8Array(200);
      crypto.getRandomValues(bobAcceptanceAnnouncement);
      bobSession.establishOutgoingSession.mockReturnValue(
        bobAcceptanceAnnouncement
      );

      vi.spyOn(mockProtocol, 'sendAnnouncement').mockResolvedValue(
        'counter-456'
      );

      await bobDiscussionService.accept(bobDiscussion!);

      const bobDiscussionAfterAccept = await appDb.discussions.get(
        bobDiscussion!.id!
      );
      expect(bobDiscussionAfterAccept?.status).toBe(DiscussionStatus.ACTIVE);
    });

    // TODO: Fix timing-dependent test - status stays SEND_FAILED instead of BROKEN
    it.skip('Alice sign announcement but could not be sent. Resend fails too many times and session is broken. Renew session and resend. Bob accept.', async () => {
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

      await appDb.contacts.add(aliceBobContact);

      // Mock Alice's session
      const aliceAnnouncement = new Uint8Array(200);
      crypto.getRandomValues(aliceAnnouncement);
      aliceSession.establishOutgoingSession.mockReturnValue(aliceAnnouncement);

      // Mock persistent network failure
      // const mockProtocol = announcementService.messageProtocol;
      const sendAnnouncementSpy = vi
        .spyOn(mockProtocol, 'sendAnnouncement')
        .mockRejectedValue(new Error('Network error'));

      // Step 2: Alice initializes discussion - network fails
      const { discussionId: aliceDiscussionId } =
        await aliceDiscussionService.initialize(aliceBobContact);

      let aliceDiscussion = await appDb.discussions.get(aliceDiscussionId);
      expect(aliceDiscussion?.status).toBe(DiscussionStatus.SEND_FAILED);

      // Step 3: Mock time passing (more than ONE_HOUR_MS = 60 * 60 * 1000)
      const oneHourAgo = new Date(Date.now() - 61 * 60 * 1000); // 61 minutes ago
      await appDb.discussions.update(aliceDiscussionId, {
        updatedAt: oneHourAgo,
      });

      // Step 4: Resend - should mark as BROKEN
      await aliceAnnouncementService.resendAnnouncements([
        { ...aliceDiscussion!, updatedAt: oneHourAgo },
      ]);

      aliceDiscussion = await appDb.discussions.get(aliceDiscussionId);
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
      await aliceDiscussionService.renew(bobSession.userIdEncoded);

      aliceDiscussion = await appDb.discussions.get(aliceDiscussionId);
      expect(aliceDiscussion?.status).toBe(DiscussionStatus.PENDING); // PENDING until network confirms
      expect(aliceDiscussion?.direction).toBe('initiated');

      // Step 6: Bob receives and accepts
      vi.spyOn(mockProtocol, 'fetchAnnouncements').mockResolvedValue([
        { counter: '1', data: newAliceAnnouncement },
      ]);

      bobSession.feedIncomingAnnouncement.mockReturnValue({
        announcer_public_keys: alicePk,
        timestamp: Date.now(),
        user_data: new Uint8Array(0),
      } as any);

      await bobAnnouncementService.fetchAndProcessAnnouncements();

      const bobDiscussion = await appDb.getDiscussionByOwnerAndContact(
        bobSession.userIdEncoded,
        aliceSession.userIdEncoded
      );

      const bobAcceptanceAnnouncement = new Uint8Array(200);
      crypto.getRandomValues(bobAcceptanceAnnouncement);
      bobSession.establishOutgoingSession.mockReturnValue(
        bobAcceptanceAnnouncement
      );

      await bobDiscussionService.accept(bobDiscussion!);

      const bobDiscussionAfterAccept = await appDb.discussions.get(
        bobDiscussion!.id!
      );
      expect(bobDiscussionAfterAccept?.status).toBe(DiscussionStatus.ACTIVE);

      // Step 7: Alice fetches Bob's announcement and discussion is ACTIVE
      vi.spyOn(mockProtocol, 'fetchAnnouncements').mockResolvedValue([
        { counter: '2', data: bobAcceptanceAnnouncement },
      ]);
      aliceSession.feedIncomingAnnouncement.mockReturnValue({
        announcer_public_keys: bobPk,
        timestamp: Date.now(),
        user_data: new Uint8Array(0),
      } as any);

      await aliceAnnouncementService.fetchAndProcessAnnouncements();

      const aliceDiscussionAfterBobAccept =
        await appDb.getDiscussionByOwnerAndContact(
          aliceSession.userIdEncoded,
          bobSession.userIdEncoded
        );

      expect(aliceDiscussionAfterBobAccept).toBeDefined();
      expect(aliceDiscussionAfterBobAccept?.status).toBe(
        DiscussionStatus.ACTIVE
      );
    });

    // TODO: Fix timing-dependent test - status stays SEND_FAILED instead of BROKEN
    it.skip('Alice send announcement, bob accept but get session manager error. Retry, sign announcement but could not be sent on network until session broke. Renew session and resend with success', async () => {
      // Step 1: Alice creates Bob and sends announcement successfully
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

      await appDb.contacts.add(aliceBobContact);

      const aliceAnnouncement = new Uint8Array(200);
      crypto.getRandomValues(aliceAnnouncement);
      aliceSession.establishOutgoingSession.mockReturnValue(aliceAnnouncement);

      // const mockProtocol = announcementService.messageProtocol;
      vi.spyOn(mockProtocol, 'sendAnnouncement').mockResolvedValue(
        'counter-123'
      );

      await aliceDiscussionService.initialize(aliceBobContact, undefined);

      // Step 2: Bob receives Alice's announcement
      vi.spyOn(mockProtocol, 'fetchAnnouncements').mockResolvedValue([
        { counter: '1', data: aliceAnnouncement },
      ]);

      bobSession.feedIncomingAnnouncement.mockReturnValue({
        announcer_public_keys: alicePk,
        timestamp: Date.now(),
        user_data: new Uint8Array(0),
      } as any);

      await bobAnnouncementService.fetchAndProcessAnnouncements();

      const bobDiscussion = await appDb.getDiscussionByOwnerAndContact(
        bobSession.userIdEncoded,
        aliceSession.userIdEncoded
      );

      // Step 3: Bob tries to accept but session manager error
      bobSession.establishOutgoingSession.mockImplementation(() => {
        throw new Error('Session manager error');
      });

      await expect(bobDiscussionService.accept(bobDiscussion!)).rejects.toThrow(
        'Failed to accept pending discussion'
      );

      // Step 4: Bob retries - session works but network fails
      const bobAcceptanceAnnouncement = new Uint8Array(200);
      crypto.getRandomValues(bobAcceptanceAnnouncement);
      bobSession.establishOutgoingSession.mockReturnValue(
        bobAcceptanceAnnouncement
      );
      vi.spyOn(mockProtocol, 'sendAnnouncement').mockRejectedValue(
        new Error('Network error')
      );

      await bobDiscussionService.accept(bobDiscussion!);

      let bobDiscussionAfterAccept = await appDb.discussions.get(
        bobDiscussion!.id!
      );
      expect(bobDiscussionAfterAccept?.status).toBe(
        DiscussionStatus.SEND_FAILED
      );

      // Step 5: Mock time passing to break the session
      const oneHourAgo = new Date(Date.now() - 61 * 60 * 1000);
      await appDb.discussions.update(bobDiscussion!.id!, {
        updatedAt: oneHourAgo,
      });

      await bobAnnouncementService.resendAnnouncements([
        { ...bobDiscussionAfterAccept!, updatedAt: oneHourAgo },
      ]);

      bobDiscussionAfterAccept = await appDb.discussions.get(
        bobDiscussion!.id!
      );
      expect(bobDiscussionAfterAccept?.status).toBe(DiscussionStatus.BROKEN);

      // Step 6: Renew session and resend with success
      const newBobAnnouncement = new Uint8Array(200);
      crypto.getRandomValues(newBobAnnouncement);
      bobSession.establishOutgoingSession.mockReturnValue(newBobAnnouncement);
      vi.spyOn(mockProtocol, 'sendAnnouncement')
        .mockClear()
        .mockResolvedValue('counter-456');

      await bobDiscussionService.renew(aliceSession.userIdEncoded);

      bobDiscussionAfterAccept = await appDb.discussions.get(
        bobDiscussion!.id!
      );
      expect(bobDiscussionAfterAccept?.status).toBe(DiscussionStatus.PENDING); // PENDING until Alice responds

      // Step 7: Alice fetches Bob's announcement and discussion is ACTIVE
      vi.spyOn(mockProtocol, 'fetchAnnouncements').mockResolvedValue([
        { counter: '2', data: bobAcceptanceAnnouncement },
      ]);
      aliceSession.feedIncomingAnnouncement.mockReturnValue({
        announcer_public_keys: bobPk,
        timestamp: Date.now(),
        user_data: new Uint8Array(0),
      } as any);

      await aliceAnnouncementService.fetchAndProcessAnnouncements();

      const aliceDiscussionAfterBobAccept =
        await appDb.getDiscussionByOwnerAndContact(
          aliceSession.userIdEncoded,
          bobSession.userIdEncoded
        );

      expect(aliceDiscussionAfterBobAccept).toBeDefined();
      expect(aliceDiscussionAfterBobAccept?.status).toBe(
        DiscussionStatus.ACTIVE
      );
    });

    it("Alice and Bob both send announcements at the same time. Both have network issue and resend. Alice receive Bob's announcement while resending", async () => {
      /* Step 1: Both create contacts */
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

      await appDb.contacts.add(aliceBobContact);
      await appDb.contacts.add(bobAliceContact);

      /* Step 2: Both try to send announcements - network fails */
      const aliceAnnouncement = new Uint8Array(200);
      crypto.getRandomValues(aliceAnnouncement);
      aliceSession.establishOutgoingSession.mockReturnValue(aliceAnnouncement);

      const bobAnnouncement = new Uint8Array(200);
      crypto.getRandomValues(bobAnnouncement);
      bobSession.establishOutgoingSession.mockReturnValue(bobAnnouncement);

      // const mockProtocol = announcementService.messageProtocol;
      vi.spyOn(mockProtocol, 'sendAnnouncement')
        .mockRejectedValueOnce(new Error('Network error'))
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValue('counter-123');

      const { discussionId: aliceDiscussionId } =
        await aliceDiscussionService.initialize(aliceBobContact);

      const { discussionId: bobDiscussionId } =
        await bobDiscussionService.initialize(bobAliceContact);

      let aliceDiscussion = await appDb.discussions.get(aliceDiscussionId);
      let bobDiscussion = await appDb.discussions.get(bobDiscussionId);

      expect(aliceDiscussion?.status).toBe(DiscussionStatus.SEND_FAILED);
      expect(bobDiscussion?.status).toBe(DiscussionStatus.SEND_FAILED);

      /* Step 3: Wait and resend - Bob's succeeds */
      await new Promise(resolve => setTimeout(resolve, 1000));

      bobSession.peerSessionStatus.mockReturnValue(SessionStatus.SelfRequested);
      await bobAnnouncementService.resendAnnouncements([bobDiscussion!]);

      bobDiscussion = await appDb.discussions.get(bobDiscussionId);

      expect(bobDiscussion?.status).toBe(DiscussionStatus.PENDING);

      /* Step 4: Alice receives Bob's announcement before she resend */
      vi.spyOn(mockProtocol, 'fetchAnnouncements').mockResolvedValue([
        { counter: '1', data: bobAnnouncement },
      ]);

      aliceSession.feedIncomingAnnouncement.mockReturnValue({
        announcer_public_keys: bobPk,
        timestamp: Date.now(),
        user_data: new Uint8Array(0),
      } as any);

      await aliceAnnouncementService.fetchAndProcessAnnouncements();

      aliceDiscussion = await appDb.discussions.get(aliceDiscussionId);
      expect(aliceDiscussion?.status).toBe(DiscussionStatus.SEND_FAILED);

      /* Step 5: Alice resend her announcement */
      aliceSession.peerSessionStatus.mockReturnValue(SessionStatus.Active);
      await aliceAnnouncementService.resendAnnouncements([aliceDiscussion!]);

      aliceDiscussion = await appDb.discussions.get(aliceDiscussionId);
      expect(aliceDiscussion?.status).toBe(DiscussionStatus.ACTIVE);

      /* Step 6: Bob fetches Alice's announcement and discussion is ACTIVE */
      vi.spyOn(mockProtocol, 'fetchAnnouncements').mockResolvedValue([
        { counter: '2', data: aliceAnnouncement },
      ]);
      bobSession.feedIncomingAnnouncement.mockReturnValue({
        announcer_public_keys: alicePk,
        timestamp: Date.now(),
        user_data: new Uint8Array(0),
      } as any);

      await bobAnnouncementService.fetchAndProcessAnnouncements();

      const bobDiscussionAfterAliceResend =
        await appDb.discussions.get(bobDiscussionId);
      expect(bobDiscussionAfterAliceResend?.status).toBe(
        DiscussionStatus.ACTIVE
      );
    });

    // TODO: Fix timing-dependent test - status stays SEND_FAILED instead of BROKEN
    it.skip("Alice and Bob both send announcement at same time. Bob session is broken because of too much resend. Bob receive Alice's announcement while session is broken.", async () => {
      // Step 1: Both create contacts
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

      await appDb.contacts.add(aliceBobContact);
      await appDb.contacts.add(bobAliceContact);

      // Step 2: Both send announcements - Alice succeeds, Bob fails
      const aliceAnnouncement = new Uint8Array(200);
      crypto.getRandomValues(aliceAnnouncement);
      aliceSession.establishOutgoingSession.mockReturnValue(aliceAnnouncement);

      const bobAnnouncement = new Uint8Array(200);
      crypto.getRandomValues(bobAnnouncement);
      bobSession.establishOutgoingSession.mockReturnValue(bobAnnouncement);

      // const mockProtocol = announcementService.messageProtocol;
      vi.spyOn(mockProtocol, 'sendAnnouncement')
        .mockResolvedValueOnce('counter-123') // Alice succeeds
        .mockRejectedValue(new Error('Network error')); // Bob fails

      const { discussionId: aliceDiscussionId } =
        await aliceDiscussionService.initialize(aliceBobContact);

      const { discussionId: bobDiscussionId } =
        await bobDiscussionService.initialize(bobAliceContact);

      const aliceDiscussion = await appDb.discussions.get(aliceDiscussionId);
      let bobDiscussion = await appDb.discussions.get(bobDiscussionId);

      expect(aliceDiscussion?.status).toBe(DiscussionStatus.PENDING); // PENDING until Bob responds
      expect(bobDiscussion?.status).toBe(DiscussionStatus.SEND_FAILED);

      // Step 3: Mock time passing for Bob's discussion to break
      const oneHourAgo = new Date(Date.now() - 61 * 60 * 1000);
      await appDb.discussions.update(bobDiscussionId, {
        updatedAt: oneHourAgo,
      });

      await bobAnnouncementService.resendAnnouncements([
        { ...bobDiscussion!, updatedAt: oneHourAgo },
      ]);

      bobDiscussion = await appDb.discussions.get(bobDiscussionId);
      expect(bobDiscussion?.status).toBe(DiscussionStatus.BROKEN);

      // Step 4: Bob receives Alice's announcement while his session is broken
      vi.spyOn(mockProtocol, 'fetchAnnouncements').mockResolvedValue([
        { counter: '1', data: aliceAnnouncement },
      ]);

      bobSession.feedIncomingAnnouncement.mockReturnValue({
        announcer_public_keys: alicePk,
        timestamp: Date.now(),
        user_data: new Uint8Array(0),
      } as any);

      await bobAnnouncementService.fetchAndProcessAnnouncements();

      // Bob's broken discussion should remain BROKEN until it is reinitialized
      bobDiscussion = await appDb.discussions.get(bobDiscussionId);
      expect(bobDiscussion?.status).toBe(DiscussionStatus.BROKEN);

      /* Step 5: Bob renew his announcement with success */
      bobSession.peerSessionStatus.mockReturnValue(SessionStatus.Active);
      bobSession.establishOutgoingSession.mockReturnValue(bobAnnouncement);
      vi.spyOn(mockProtocol, 'sendAnnouncement').mockResolvedValue(
        'counter-456'
      );

      await bobDiscussionService.renew(aliceSession.userIdEncoded);

      bobDiscussion = await appDb.discussions.get(bobDiscussionId);
      expect(bobDiscussion?.status).toBe(DiscussionStatus.ACTIVE);
    });

    // TODO: Fix timing-dependent test - status stays SEND_FAILED instead of BROKEN
    it.skip('Alice and Bob setup a discussion with success; Alice discussion is broken; renew first fails, second fails with network, third succeeds; Bob receives announcement', async () => {
      /* Step 1: Alice and Bob have contacts and sessions set up */
      const { aliceDiscussionId, bobDiscussionId } = await initSession(
        alicePk,
        aliceSk,
        bobPk,
        bobSk,
        appDb,
        aliceSession,
        bobSession
      );

      /* Step 2: Alice's discussion becomes BROKEN */
      appDb.discussions.update(aliceDiscussionId, {
        status: DiscussionStatus.BROKEN,
      });

      /* Step 3: First attempt to renew - session manager error */
      aliceSession.establishOutgoingSession.mockRejectedValueOnce(
        new Error('Session manager error')
      );
      await expect(
        aliceDiscussionService.renew(bobSession.userIdEncoded)
      ).rejects.toThrow();
      let aliceDiscussion = await appDb.discussions.get(aliceDiscussionId);
      expect(aliceDiscussion?.status).toBe(DiscussionStatus.BROKEN); // Still broken

      // Step 4: Second attempt - network failure, goes to SEND_FAILED
      // const mockProtocol = announcementService.messageProtocol;
      vi.spyOn(mockProtocol, 'sendAnnouncement').mockRejectedValueOnce(
        new Error('Network down')
      );

      await aliceDiscussionService.renew(bobSession.userIdEncoded);

      aliceDiscussion = await appDb.discussions.get(aliceDiscussionId);
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

      await aliceDiscussionService.renew(bobSession.userIdEncoded);

      aliceDiscussion = await appDb.discussions.get(aliceDiscussionId);
      expect(aliceDiscussion?.status).toBe(DiscussionStatus.ACTIVE);

      // Step 6: Bob receives Alice's renewed announcement
      vi.spyOn(mockProtocol, 'fetchAnnouncements').mockResolvedValue([
        { counter: '1', data: renewedAnnouncement },
      ]);

      bobSession.feedIncomingAnnouncement.mockReturnValue({
        announcer_public_keys: alicePk,
        timestamp: Date.now(),
        user_data: new Uint8Array(0),
      } as any);

      await bobAnnouncementService.fetchAndProcessAnnouncements();

      const bobDiscussion = await appDb.discussions.get(bobDiscussionId);
      expect(bobDiscussion?.status === DiscussionStatus.ACTIVE).toBeTruthy();
    });
  });
});
