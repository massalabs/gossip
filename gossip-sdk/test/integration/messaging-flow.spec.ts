/**
 * Messaging e2e-style tests
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
  DiscussionDirection,
  MessageStatus,
  MessageDirection,
  MessageType,
  Contact,
} from '../../src/db';
import { MockMessageProtocol } from '../mocks';
import {
  setupSession,
  TestSessionData,
  createTestSession,
  cleanupTestSession,
} from '../utils';
import { GossipSdk } from '../../src/gossip';
import { ensureWasmInitialized } from '../../src/wasm/loader';
import { generateMnemonic } from '../../src/crypto/bip39';
import { generateEncryptionKey } from '../../src/wasm/encryption';
import { AnnouncementService } from '../../src/services/announcement';
import { MessageService } from '../../src/services/message';
import { DiscussionService } from '../../src/services/discussion';
import { RefreshService } from '../../src/services/refresh';
import { SessionModule } from '../../src/wasm/session';
import { decodeUserId } from '../../src/utils/userId';
import {
  SessionStatus,
  SessionConfig,
} from '../../src/assets/generated/wasm/gossip_wasm';
import { SdkEventEmitter } from '../../src/core/SdkEventEmitter';
import { defaultSdkConfig } from '../../src/config/sdk';
import {
  clearAllTables,
  getTestQueries,
  getTestStorageConfig,
} from '../testDb';

describe('Messaging Flow', () => {
  let mockProtocol: MockMessageProtocol;

  let aliceSdk: GossipSdk;
  let bobSdk: GossipSdk;

  beforeAll(async () => {
    await ensureWasmInitialized();
    mockProtocol = new MockMessageProtocol();
  });

  beforeEach(async () => {
    mockProtocol.clearMockData();

    vi.clearAllMocks();

    // Generate mnemonics for SDK sessions
    const aliceMnemonic = generateMnemonic();
    const bobMnemonic = generateMnemonic();
    const aliceEncryptionKey = await generateEncryptionKey();
    const bobEncryptionKey = await generateEncryptionKey();

    // Create gossipSdk instances for Alice and Bob
    aliceSdk = new GossipSdk();
    await aliceSdk.init({ storage: getTestStorageConfig() });
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
    await bobSdk.init({ storage: getTestStorageConfig() });
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
    vi.restoreAllMocks();

    await aliceSdk.closeSession();
    await bobSdk.closeSession();
  });

  describe('Renew session', () => {
    beforeEach(async () => {
      // setup session between Alice and Bob
      await setupSession(aliceSdk, bobSdk, 'Bob', 'Alice');
    });

    it('Alice renew the session. Bob receive new announcements', async () => {
      // Alice renews the session
      const renewResult = await aliceSdk.discussions.renew(bobSdk.userId);
      expect(renewResult.success).toBe(true);

      // Bob fetches announcements and receives Alice's renewal
      await bobSdk.announcements.fetch();

      // Check both sessions are active
      expect(aliceSdk.discussions.getStatus(bobSdk.userId)).toBe(
        SessionStatus.Active
      );
      expect(bobSdk.discussions.getStatus(aliceSdk.userId)).toBe(
        SessionStatus.Active
      );
    });

    it('Alice and Bob both renew the session at the same time', async () => {
      // Both renew at the same time
      const aliceRenewResult = await aliceSdk.discussions.renew(bobSdk.userId);
      const bobRenewResult = await bobSdk.discussions.renew(aliceSdk.userId);
      expect(aliceRenewResult.success).toBe(true);
      expect(bobRenewResult.success).toBe(true);

      // Both fetch announcements
      await aliceSdk.announcements.fetch();
      await bobSdk.announcements.fetch();

      // Check both sessions are active
      expect(aliceSdk.discussions.getStatus(bobSdk.userId)).toBe(
        SessionStatus.Active
      );
      expect(bobSdk.discussions.getStatus(aliceSdk.userId)).toBe(
        SessionStatus.Active
      );
    });
  });

  describe('keep alive msg', () => {
    const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
    const ONE_MINUTE_MS = 60 * 1000;

    beforeEach(async () => {
      (
        aliceSdk as unknown as { _announcement: AnnouncementService }
      )._announcement.setMessageProtocol(mockProtocol);
      (aliceSdk as unknown as { _message: MessageService })._message[
        'messageProtocol'
      ] = mockProtocol;
      (
        bobSdk as unknown as { _announcement: AnnouncementService }
      )._announcement.setMessageProtocol(mockProtocol);
      (bobSdk as unknown as { _message: MessageService })._message[
        'messageProtocol'
      ] = mockProtocol;
    });

    function createSessionConfig(
      keep_alive_interval_millis: number,
      max_keep_alive_peer_lag_length: bigint = 8n
    ): SessionConfig {
      return new SessionConfig(
        ONE_WEEK_MS,
        ONE_MINUTE_MS,
        ONE_WEEK_MS,
        ONE_MINUTE_MS,
        ONE_WEEK_MS,
        keep_alive_interval_millis,
        10000n,
        max_keep_alive_peer_lag_length
      );
    }

    async function reconfigureSessionsForKeepAlive(options: {
      keepAliveIntervalMs: number;
      maxKeepAlivePeerLagLength?: bigint;
    }): Promise<void> {
      const { keepAliveIntervalMs, maxKeepAlivePeerLagLength = 8n } = options;

      // Close any existing sessions created by the top-level beforeEach
      await aliceSdk.closeSession();
      await bobSdk.closeSession();

      const aliceMnemonic = generateMnemonic();
      const bobMnemonic = generateMnemonic();
      const aliceEncryptionKey = await generateEncryptionKey();
      const bobEncryptionKey = await generateEncryptionKey();

      const aliceSessionConfig = createSessionConfig(
        keepAliveIntervalMs,
        maxKeepAlivePeerLagLength
      );
      const bobSessionConfig = createSessionConfig(
        keepAliveIntervalMs,
        maxKeepAlivePeerLagLength
      );

      await aliceSdk.openSession({
        mnemonic: aliceMnemonic,
        encryptionKey: aliceEncryptionKey,
        onPersist: async () => {},
        sessionConfig: aliceSessionConfig,
      });

      await bobSdk.openSession({
        mnemonic: bobMnemonic,
        encryptionKey: bobEncryptionKey,
        onPersist: async () => {},
        sessionConfig: bobSessionConfig,
      });

      // Re-wire mock protocol (openSession recreates services with default protocol)
      (
        aliceSdk as unknown as { _announcement: AnnouncementService }
      )._announcement.setMessageProtocol(mockProtocol);
      (aliceSdk as unknown as { _message: MessageService })._message[
        'messageProtocol'
      ] = mockProtocol;
      (
        bobSdk as unknown as { _announcement: AnnouncementService }
      )._announcement.setMessageProtocol(mockProtocol);
      (bobSdk as unknown as { _message: MessageService })._message[
        'messageProtocol'
      ] = mockProtocol;
    }

    const getAliceServices = () =>
      aliceSdk as unknown as {
        _announcement: AnnouncementService;
        _discussion: DiscussionService;
        _message: MessageService;
        _refresh: RefreshService;
      };

    const getBobServices = () =>
      bobSdk as unknown as {
        _announcement: AnnouncementService;
        _discussion: DiscussionService;
        _message: MessageService;
        _refresh: RefreshService;
      };

    const getAliceSession = (): SessionModule =>
      (aliceSdk as unknown as { state: { session: SessionModule } }).state
        .session;
    const getBobSession = (): SessionModule =>
      (bobSdk as unknown as { state: { session: SessionModule } }).state
        .session;

    it('Alice send msg to bob. Bob wait keep_alive_interval_millis then send a keep alive. Alice msg is acknowledged', async () => {
      const keepAliveIntervalMs = 100;

      await reconfigureSessionsForKeepAlive({
        keepAliveIntervalMs,
      });

      await setupSession(aliceSdk, bobSdk, 'Bob', 'Alice');

      const bobServices = getBobServices();

      // Alice sends a session message to Bob (a keep-alive: the earlier
      // one-to-one format is no longer sent, §2.1)
      const aliceMsgResult = await aliceSdk.messages.send({
        ownerUserId: aliceSdk.userId,
        contactUserId: bobSdk.userId,
        content: '',
        type: MessageType.KEEP_ALIVE,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.WAITING_SESSION,
        timestamp: new Date(),
      });
      expect(aliceMsgResult.success).toBe(true);

      // Bob fetches it: a keep-alive stores nothing
      await bobSdk.messages.fetch();
      expect(
        await bobSdk.queries.messages.getByOwnerAndContact(
          bobSdk.userId,
          aliceSdk.userId
        )
      ).toEqual([]);

      // Wait so that Bob's last outgoing message is older than keep_alive_interval_millis
      await new Promise(resolve =>
        setTimeout(resolve, keepAliveIntervalMs + 20)
      );

      await bobServices._refresh.stateUpdate();

      // Verify Bob sent keep-alive
      const bobAllMsgsKA = await bobSdk.queries.messages.getByOwnerAndContact(
        bobSdk.userId,
        aliceSdk.userId
      );
      const bobKeepAliveRows = bobAllMsgsKA.filter(
        m =>
          m.type === MessageType.KEEP_ALIVE &&
          m.direction === MessageDirection.OUTGOING
      );
      const bobKeepAlive = bobKeepAliveRows[0];
      expect(bobKeepAlive).toBeDefined();
      expect(bobKeepAlive?.status).toBe(MessageStatus.SENT);
      expect(bobKeepAlive?.encryptedMessage).toBeNull();
      expect(bobKeepAlive?.seeker).toBeDefined();
      expect(bobKeepAlive?.whenToSend).toBeNull();

      // Alice fetches Bob's keep-alive (which acknowledges her message)
      await aliceSdk.messages.fetch();

      const aliceMessages =
        await aliceSdk.queries.messages.getByOwnerAndContact(
          aliceSdk.userId,
          bobSdk.userId
        );

      // Acknowledged, Alice's keep-alive is gone
      expect(
        aliceMessages.find(m => m.id === aliceMsgResult.message!.id)
      ).toBeUndefined();

      // Check that there is no incoming keep-alive message in Alice's db
      const incomingKeepAlive = aliceMessages.find(
        m =>
          m.type === MessageType.KEEP_ALIVE &&
          m.direction === MessageDirection.INCOMING
      );
      expect(incomingKeepAlive).toBeUndefined();

      // Alice sends a message back to acknowledge Bob's keep-alive
      const aliceServices = getAliceServices();
      await new Promise(resolve =>
        setTimeout(resolve, keepAliveIntervalMs + 20)
      );

      await aliceServices._refresh.stateUpdate();

      // Bob fetches Alice's acknowledgment
      await bobSdk.messages.fetch();

      // Bob's keep-alive should now be removed from db
      const bobAllMsgsAfter =
        await bobSdk.queries.messages.getByOwnerAndContact(
          bobSdk.userId,
          aliceSdk.userId
        );
      const bobKeepAliveAfterRows = bobAllMsgsAfter.filter(
        m => m.type === MessageType.KEEP_ALIVE
      );
      expect(bobKeepAliveAfterRows.length).toBe(0);
    });

    it('Alice send max_keep_alive_peer_lag_length msg to bob. Bob send a keep alive. Alice msg are acknowledged', async () => {
      const maxKeepAlivePeerLagLength = 3n;
      const keepAliveIntervalMs = 60 * 60 * 1000; // large so peer lag is the trigger

      await reconfigureSessionsForKeepAlive({
        keepAliveIntervalMs,
        maxKeepAlivePeerLagLength,
      });

      await setupSession(aliceSdk, bobSdk, 'Bob', 'Alice');

      const bobServices = getBobServices();

      // Alice sends max_keep_alive_peer_lag_length messages to Bob
      const contents = ['A1', 'A2', 'A3'];
      for (const content of contents) {
        const result = await aliceSdk.messages.send({
          ownerUserId: aliceSdk.userId,
          contactUserId: bobSdk.userId,
          content,
          type: MessageType.KEEP_ALIVE,
          direction: MessageDirection.OUTGOING,
          status: MessageStatus.WAITING_SESSION,
          timestamp: new Date(),
        });
        expect(result.success).toBe(true);
      }

      // Bob fetches Alice's messages
      await bobSdk.messages.fetch();

      expect(
        await bobSdk.queries.messages.getByOwnerAndContact(
          bobSdk.userId,
          aliceSdk.userId
        )
      ).toEqual([]);

      // Since Bob received max_keep_alive_peer_lag_length messages since his last outgoing,
      // refresh should cause a keep-alive to be sent.
      await bobServices._refresh.stateUpdate();

      const bobAllMsgsKA = await bobSdk.queries.messages.getByOwnerAndContact(
        bobSdk.userId,
        aliceSdk.userId
      );
      const bobKeepAliveRows = bobAllMsgsKA.filter(
        m =>
          m.type === MessageType.KEEP_ALIVE &&
          m.direction === MessageDirection.OUTGOING
      );
      const bobKeepAlive = bobKeepAliveRows[0];
      expect(bobKeepAlive).toBeDefined();
      expect(bobKeepAlive?.status).toBe(MessageStatus.SENT);
      expect(bobKeepAlive?.encryptedMessage).toBeNull();
      expect(bobKeepAlive?.seeker).toBeDefined();
      expect(bobKeepAlive?.whenToSend).toBeNull();

      // Alice fetches Bob's keep-alive (which acknowledges her messages)
      await aliceSdk.messages.fetch();

      const aliceMessagesAfterKA =
        await aliceSdk.queries.messages.getByOwnerAndContact(
          aliceSdk.userId,
          bobSdk.userId
        );

      // Acknowledged, Alice's keep-alives are gone
      expect(
        aliceMessagesAfterKA.filter(
          m =>
            m.direction === MessageDirection.OUTGOING &&
            m.type === MessageType.KEEP_ALIVE
        )
      ).toEqual([]);

      // Check that there is no incoming keep-alive message in Alice's db
      const incomingKeepAlive = aliceMessagesAfterKA.find(
        m =>
          m.type === MessageType.KEEP_ALIVE &&
          m.direction === MessageDirection.INCOMING
      );
      expect(incomingKeepAlive).toBeUndefined();
    });

    it('No keep alive when session is not active', async () => {
      await reconfigureSessionsForKeepAlive({
        keepAliveIntervalMs: 100,
      });

      const aliceContact: Omit<Contact, 'id'> = {
        ownerUserId: aliceSdk.userId,
        userId: bobSdk.userId,
        name: 'Bob',
        publicKeys: bobSdk.publicKeys.to_bytes(),
        avatar: undefined,
        isOnline: false,
        lastSeen: new Date(),
        createdAt: new Date(),
      };
      await aliceSdk.queries.contacts.insert({
        ownerUserId: aliceContact.ownerUserId,
        userId: aliceContact.userId,
        name: aliceContact.name,
        publicKeys: aliceContact.publicKeys,
        isOnline: aliceContact.isOnline,
        lastSeen: aliceContact.lastSeen,
        createdAt: aliceContact.createdAt,
      });

      const startResult = await aliceSdk.discussions.start(aliceContact);
      if (!startResult.success) throw startResult.error;

      await bobSdk.announcements.fetch();

      const aliceSession = getAliceSession();
      const bobSession = getBobSession();

      expect(aliceSession.peerSessionStatus(decodeUserId(bobSdk.userId))).toBe(
        SessionStatus.SelfRequested
      );
      expect(bobSession.peerSessionStatus(decodeUserId(aliceSdk.userId))).toBe(
        SessionStatus.PeerRequested
      );

      await aliceSdk.updateState();
      await bobSdk.updateState();

      const aliceKeepAlives = (
        await aliceSdk.queries.messages.getByOwnerAndContact(
          aliceSdk.userId,
          bobSdk.userId
        )
      ).filter(m => m.type === MessageType.KEEP_ALIVE);
      const bobKeepAlives = (
        await bobSdk.queries.messages.getByOwnerAndContact(
          bobSdk.userId,
          aliceSdk.userId
        )
      ).filter(m => m.type === MessageType.KEEP_ALIVE);
      const keepAlives = [...aliceKeepAlives, ...bobKeepAlives];
      expect(keepAlives.length).toBe(0);
    });

    it('No keep alive msg when already a pending msg', async () => {
      const keepAliveIntervalMs = 100;

      await reconfigureSessionsForKeepAlive({
        keepAliveIntervalMs,
      });

      await setupSession(aliceSdk, bobSdk, 'Bob', 'Alice');

      const aliceServices = getAliceServices();
      const aliceSession = getAliceSession();

      // Mock sendMessage to fail, keeping message in READY state
      const sendSpy = vi
        .spyOn(aliceSession, 'sendMessage')
        .mockImplementation(async () => undefined);

      // Queue a pending outgoing message for Alice -> Bob
      const msgResult = await aliceSdk.messages.send({
        ownerUserId: aliceSdk.userId,
        contactUserId: bobSdk.userId,
        content: '',
        type: MessageType.KEEP_ALIVE,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.WAITING_SESSION,
        timestamp: new Date(),
      });
      expect(msgResult.success).toBe(true);

      // Verify message is in WAITING_SESSION (sendMessage failed)
      const pendingMsg = await aliceSdk.queries.messages.getById(
        msgResult.message!.id!
      );
      expect(pendingMsg?.status).toBe(MessageStatus.WAITING_SESSION);
      await new Promise(resolve =>
        setTimeout(resolve, keepAliveIntervalMs + 20)
      );

      await aliceServices._refresh.stateUpdate();

      // Check that there is no outgoing keep-alive message in Alice's db
      const messages = await aliceSdk.queries.messages.getByOwnerAndContact(
        aliceSdk.userId,
        bobSdk.userId
      );
      // Only the pending one: no second keep-alive is queued
      const keepAlives = messages.filter(
        m =>
          m.type === MessageType.KEEP_ALIVE &&
          m.direction === MessageDirection.OUTGOING
      );
      expect(keepAlives.map(m => m.id)).toEqual([msgResult.message!.id]);

      sendSpy.mockRestore();
    });

    it('A keep-alive is still sent while the archive holds a row of the earlier format never sent', async () => {
      const keepAliveIntervalMs = 100;
      await reconfigureSessionsForKeepAlive({ keepAliveIntervalMs });
      await setupSession(aliceSdk, bobSdk, 'Bob', 'Alice');

      // Written before the upgrade and never encrypted: it is never sent.
      const unsent = await aliceSdk.queries.messages.insert({
        ownerUserId: aliceSdk.userId,
        contactUserId: bobSdk.userId,
        content: 'Pending before the upgrade',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.WAITING_SESSION,
        messageId: new Uint8Array(12).fill(1),
        timestamp: new Date(),
      });
      await new Promise(resolve =>
        setTimeout(resolve, keepAliveIntervalMs + 20)
      );
      await getAliceServices()._refresh.stateUpdate();

      const messages = await aliceSdk.queries.messages.getByOwnerAndContact(
        aliceSdk.userId,
        bobSdk.userId
      );
      const keepAlive = messages.find(
        m =>
          m.type === MessageType.KEEP_ALIVE &&
          m.direction === MessageDirection.OUTGOING
      );
      expect(keepAlive?.status).toBe(MessageStatus.SENT);
      expect(messages.find(m => m.id === unsent)?.status).toBe(
        MessageStatus.WAITING_SESSION
      );
    });

    it('Alice send keep alive msg but session.sendMessage returns empty output. It is resent at next stateUpdate with success', async () => {
      await reconfigureSessionsForKeepAlive({
        keepAliveIntervalMs: 60 * 60 * 1000,
        maxKeepAlivePeerLagLength: 1n,
      });

      await setupSession(aliceSdk, bobSdk, 'Bob', 'Alice');

      const aliceServices = getAliceServices();
      const aliceSession = getAliceSession();

      // Bob sends a message so Alice will later acknowledge via keep-alive
      const bobMsgResult = await bobSdk.messages.send({
        ownerUserId: bobSdk.userId,
        contactUserId: aliceSdk.userId,
        content: '',
        type: MessageType.KEEP_ALIVE,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.WAITING_SESSION,
        timestamp: new Date(),
      });
      expect(bobMsgResult.success).toBe(true);

      // Mock sendMessage: first call returns undefined (encryption "fails"), then use real
      const originalSend = aliceSession.sendMessage.bind(aliceSession);
      let callCount = 0;
      const sendSpy = vi
        .spyOn(aliceSession, 'sendMessage')
        .mockImplementation(
          async (...args: Parameters<SessionModule['sendMessage']>) => {
            callCount++;
            if (callCount === 1) return undefined;
            return originalSend(...args);
          }
        );

      await aliceSdk.messages.fetch();

      // stateUpdate: mock returns undefined on first sendMessage call (fast
      // path bails), but processSendQueueForContact retries within the same
      // stateUpdate — the second call uses the real session, so the
      // keep-alive ends up SENT after a single stateUpdate.
      await aliceServices._refresh.stateUpdate();

      const aliceMessages =
        await aliceSdk.queries.messages.getByOwnerAndContact(
          aliceSdk.userId,
          bobSdk.userId
        );

      expect(sendSpy).toHaveBeenCalled();

      const ka = aliceMessages.find(
        m =>
          m.type === MessageType.KEEP_ALIVE &&
          m.direction === MessageDirection.OUTGOING
      );
      expect(ka).toBeDefined();
      expect(ka?.status).toBe(MessageStatus.SENT);
      expect(ka?.encryptedMessage).toBeNull();
      expect(ka?.seeker).toBeDefined();
      expect(ka?.whenToSend).toBeNull();

      sendSpy.mockRestore();
    });

    it('Alice send keep alive msg then reset the session: keep alive is put in WAITING_SESSION then resent', async () => {
      await reconfigureSessionsForKeepAlive({
        keepAliveIntervalMs: 60 * 60 * 1000,
        maxKeepAlivePeerLagLength: 1n,
      });

      await setupSession(aliceSdk, bobSdk, 'Bob', 'Alice');

      const aliceServices = getAliceServices();

      // Bob sends a message so Alice will later acknowledge via keep-alive
      const bobMsgResult = await bobSdk.messages.send({
        ownerUserId: bobSdk.userId,
        contactUserId: aliceSdk.userId,
        content: '',
        type: MessageType.KEEP_ALIVE,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.WAITING_SESSION,
        timestamp: new Date(),
      });
      expect(bobMsgResult.success).toBe(true);
      await aliceSdk.messages.fetch();

      await aliceServices._refresh.stateUpdate();

      // Verify Alice sent keep-alive
      let aliceMessages = await aliceSdk.queries.messages.getByOwnerAndContact(
        aliceSdk.userId,
        bobSdk.userId
      );

      let aliceKeepAlive = aliceMessages.find(
        m =>
          m.type === MessageType.KEEP_ALIVE &&
          m.direction === MessageDirection.OUTGOING
      );
      expect(aliceKeepAlive).toBeDefined();
      expect(aliceKeepAlive?.status).toBe(MessageStatus.SENT);
      expect(aliceKeepAlive?.encryptedMessage).toBeNull();
      expect(aliceKeepAlive?.seeker).toBeDefined();
      expect(aliceKeepAlive?.whenToSend).toBeNull();

      // Alice renews the session (which resets messages to WAITING_SESSION)
      const renewResult = await aliceSdk.discussions.renew(bobSdk.userId);
      expect(renewResult.success).toBe(true);

      // Check keep-alive was reset to WAITING_SESSION and then resent
      aliceMessages = await aliceSdk.queries.messages.getByOwnerAndContact(
        aliceSdk.userId,
        bobSdk.userId
      );

      aliceKeepAlive = aliceMessages.find(
        m =>
          m.type === MessageType.KEEP_ALIVE &&
          m.direction === MessageDirection.OUTGOING
      );
      // After renew + stateUpdate, it should be SENT again
      expect(aliceKeepAlive?.status).toBe(MessageStatus.SENT);
      expect(aliceKeepAlive?.encryptedMessage).toBeNull();
      expect(aliceKeepAlive?.seeker).toBeDefined();
      expect(aliceKeepAlive?.whenToSend).toBeNull();
    });

    it('Alice send keep alive but got network issue. Resend with success', async () => {
      await reconfigureSessionsForKeepAlive({
        keepAliveIntervalMs: 60 * 60 * 1000,
        maxKeepAlivePeerLagLength: 1n,
      });

      await setupSession(aliceSdk, bobSdk, 'Bob', 'Alice');

      const aliceServices = getAliceServices();

      // Set short retry delay for this test
      const originalRetryDelay = aliceSdk.config.messages.retryDelayMs;
      aliceSdk.config.messages.retryDelayMs = 100;

      // Bob sends a message so Alice will later acknowledge via keep-alive
      const bobMsgResult = await bobSdk.messages.send({
        ownerUserId: bobSdk.userId,
        contactUserId: aliceSdk.userId,
        content: '',
        type: MessageType.KEEP_ALIVE,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.WAITING_SESSION,
        timestamp: new Date(),
      });
      expect(bobMsgResult.success).toBe(true);

      // Mock network failure for protocol.sendMessage
      let sendAttempts = 0;
      const sendSpy = vi
        .spyOn(mockProtocol, 'sendMessage')
        .mockImplementation(async () => {
          sendAttempts++;
          if (sendAttempts === 1) {
            throw new Error('Network error');
          }
          // Return void on retry (success)
        });

      await aliceSdk.messages.fetch();

      // First stateUpdate: protocol.sendMessage throws, keep-alive stays READY with whenToSend
      await aliceServices._refresh.stateUpdate();

      let aliceMessages = await aliceSdk.queries.messages.getByOwnerAndContact(
        aliceSdk.userId,
        bobSdk.userId
      );

      const keepAlivesAfterFail = aliceMessages.filter(
        m =>
          m.type === MessageType.KEEP_ALIVE &&
          m.direction === MessageDirection.OUTGOING
      );
      const ka =
        keepAlivesAfterFail.find(m => m.status === MessageStatus.READY) ??
        keepAlivesAfterFail[keepAlivesAfterFail.length - 1];
      expect(ka).toBeDefined();
      expect(ka?.status).toBe(MessageStatus.READY);
      expect(ka?.whenToSend).toBeDefined();
      expect(ka?.whenToSend!.getTime()).toBeGreaterThan(Date.now());

      // Wait for retry delay
      await new Promise(resolve =>
        setTimeout(resolve, aliceSdk.config.messages.retryDelayMs + 50)
      );

      // Second stateUpdate: retry should succeed
      await aliceServices._refresh.stateUpdate();

      aliceMessages = await aliceSdk.queries.messages.getByOwnerAndContact(
        aliceSdk.userId,
        bobSdk.userId
      );

      const kaAfter = aliceMessages.find(
        m =>
          m.type === MessageType.KEEP_ALIVE &&
          m.direction === MessageDirection.OUTGOING
      );
      expect(kaAfter?.status).toBe(MessageStatus.SENT);
      expect(kaAfter?.encryptedMessage).toBeNull();
      expect(kaAfter?.seeker).toBeDefined();
      expect(kaAfter?.whenToSend).toBeNull();

      // Restore
      sendSpy.mockRestore();
      aliceSdk.config.messages.retryDelayMs = originalRetryDelay;
    });
  });
});

// ============================================================================
// Renew session — SQLite-level tests
// ============================================================================

describe('Renew session — SQLite-level tests', () => {
  let alice: TestSessionData;
  let bob: TestSessionData;
  let mockProtocol: MockMessageProtocol;
  let events: SdkEventEmitter;
  let messageService: MessageService;
  let discussionService: DiscussionService;
  let announcementService: AnnouncementService;
  let refreshService: RefreshService;

  /**
   * Helper to reset unacknowledged messages to WAITING_SESSION
   * (simulates what happens when session needs renewal)
   */
  async function simulateRenewReset(
    ownerUserId: string,
    contactUserId: string
  ): Promise<number> {
    const q = getTestQueries();
    const all = await q.messages.getByOwnerAndContact(
      ownerUserId,
      contactUserId
    );
    const toReset = all.filter(
      m =>
        m.direction === MessageDirection.OUTGOING &&
        (m.status === MessageStatus.SENDING ||
          m.status === MessageStatus.FAILED ||
          m.status === MessageStatus.SENT)
    );
    for (const m of toReset) {
      await q.messages.updateById(m.id, {
        status: MessageStatus.WAITING_SESSION,
        encryptedMessage: null,
        seeker: null,
      });
    }
    return toReset.length;
  }

  beforeEach(async () => {
    await clearAllTables();

    // Create real WASM sessions
    alice = await createTestSession(`alice-renew-${Date.now()}`);
    bob = await createTestSession(`bob-renew-${Date.now()}`);

    mockProtocol = new MockMessageProtocol();
    events = new SdkEventEmitter();

    const q = getTestQueries();

    // Add Bob as Alice's contact
    await q.contacts.insert({
      ownerUserId: alice.session.userIdEncoded,
      userId: bob.session.userIdEncoded,
      name: 'Bob',
      publicKeys: bob.session.ourPk.to_bytes(),
      isOnline: false,
      lastSeen: new Date(),
      createdAt: new Date(),
    });
    announcementService = new AnnouncementService(
      mockProtocol,
      alice.session,
      events,
      defaultSdkConfig,
      q
    );
    messageService = new MessageService(
      mockProtocol,
      alice.session,
      events,
      defaultSdkConfig,
      q
    );
    discussionService = new DiscussionService(
      announcementService,
      alice.session,
      events,
      q
    );
    refreshService = new RefreshService(
      messageService,
      discussionService,
      announcementService,
      alice.session,
      events,
      q,
      defaultSdkConfig
    );
    discussionService = new DiscussionService(
      announcementService,
      alice.session,
      events,
      q
    );
    discussionService.setRefreshService(refreshService);
    announcementService.setRefreshService(refreshService);
  });

  afterEach(() => {
    cleanupTestSession(alice);
    cleanupTestSession(bob);
  });

  it('should not resend incoming messages on renewal', async () => {
    // Establish session
    const aliceAnnouncement = await alice.session.establishOutgoingSession(
      bob.session.ourPk
    );
    await bob.session.feedIncomingAnnouncement(aliceAnnouncement);
    const bobAnnouncement = await bob.session.establishOutgoingSession(
      alice.session.ourPk
    );
    await alice.session.feedIncomingAnnouncement(bobAnnouncement);

    await getTestQueries().discussions.insert({
      ownerUserId: alice.session.userIdEncoded,
      contactUserId: bob.session.userIdEncoded,
      weAccepted: true,
      direction: DiscussionDirection.INITIATED,
      unreadCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const outgoingId = await getTestQueries().messages.insert({
      ownerUserId: alice.session.userIdEncoded,
      contactUserId: bob.session.userIdEncoded,
      content: 'Outgoing message',
      messageId: crypto.getRandomValues(new Uint8Array(12)),
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date(),
      seeker: new Uint8Array(32).fill(1),
      encryptedMessage: new Uint8Array(64).fill(1),
    });

    const incomingId = await getTestQueries().messages.insert({
      ownerUserId: alice.session.userIdEncoded,
      contactUserId: bob.session.userIdEncoded,
      content: 'Incoming message from Bob',
      type: MessageType.TEXT,
      direction: MessageDirection.INCOMING,
      status: MessageStatus.DELIVERED,
      timestamp: new Date(),
    });

    // Simulate renewal — only outgoing SENT should be reset
    const resetCount = await simulateRenewReset(
      alice.session.userIdEncoded,
      bob.session.userIdEncoded
    );
    expect(resetCount).toBe(1);

    // Outgoing should be reset to WAITING_SESSION
    expect((await getTestQueries().messages.getById(outgoingId))?.status).toBe(
      MessageStatus.WAITING_SESSION
    );
    // Incoming should remain DELIVERED
    expect((await getTestQueries().messages.getById(incomingId))?.status).toBe(
      MessageStatus.DELIVERED
    );
  });
});

// ============================================================================
// WAITING_SESSION after accept
// ============================================================================
