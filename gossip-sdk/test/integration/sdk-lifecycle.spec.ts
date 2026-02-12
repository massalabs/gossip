/**
 * GossipSdk lifecycle and event wiring tests
 *
 * Uses vi.mock() and hoisted state for SDK dependencies.
 * Each test creates a fresh GossipSdk instance in beforeEach so
 * that module-level state and WASM-backed services don't leak between tests.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  generateEncryptionKeyFromSeed,
  type EncryptionKey,
} from '../../src/wasm/encryption';
import { GossipSdk, SdkEventType } from '../../src/gossipSdk';

const protocolMock = vi.hoisted(() => ({
  createMessageProtocolMock: vi.fn(),
}));

const eventState = vi.hoisted(() => ({
  lastEvents: null as {
    onMessageReceived?: (message: unknown) => void;
  } | null,
}));

const createEventsForEmitter = (emitter: {
  emit: (type: SdkEventType, payload: unknown) => void;
}) => ({
  onMessageReceived: (message: unknown) => {
    emitter.emit(SdkEventType.MESSAGE_RECEIVED, message);
  },
});

let sdk: GossipSdk;

vi.mock('../../src/api/messageProtocol', () => ({
  createMessageProtocol: () => protocolMock.createMessageProtocolMock(),
}));

vi.mock('../../src/services/auth', () => ({
  AuthService: class {
    ensurePublicKeyPublished = vi.fn().mockResolvedValue(undefined);
    constructor() {}
  },
}));

vi.mock('../../src/services/announcement', () => ({
  AnnouncementService: class {
    setRefreshService = vi.fn();
    fetchAndProcessAnnouncements = vi.fn();
    constructor(
      _db: unknown,
      _protocol: unknown,
      _session: unknown,
      eventEmitter: { emit: (type: SdkEventType, payload: unknown) => void }
    ) {
      eventState.lastEvents = createEventsForEmitter(eventEmitter);
    }
  },
}));

vi.mock('../../src/services/message', () => ({
  MessageService: class {
    sendMessage = vi.fn();
    fetchMessages = vi.fn();
    processSendQueueForContact = vi.fn();
    getPendingSendCount = vi.fn().mockResolvedValue(0);
    findMessageBySeeker = vi.fn();
    setRefreshService = vi.fn();

    constructor(
      _db: unknown,
      _protocol: unknown,
      _session: unknown,
      _discussion: unknown,
      eventEmitter: { emit: (type: SdkEventType, payload: unknown) => void }
    ) {
      eventState.lastEvents = createEventsForEmitter(eventEmitter);
    }
  },
}));

vi.mock('../../src/services/discussion', () => ({
  DiscussionService: class {
    initialize = vi.fn();
    accept = vi.fn();
    createSessionForContact = vi.fn();
    isStableState = vi.fn();
    setRefreshService = vi.fn();
    constructor(
      _db: unknown,
      _announcement: unknown,
      _session: unknown,
      eventEmitter: { emit: (type: SdkEventType, payload: unknown) => void }
    ) {
      eventState.lastEvents = createEventsForEmitter(eventEmitter);
    }
  },
}));

vi.mock('../../src/services/refresh', () => ({
  RefreshService: class {
    stateUpdate = vi.fn();
    constructor(
      _db: unknown,
      _message: unknown,
      _discussion: unknown,
      _announcement: unknown,
      _session: unknown,
      eventEmitter: { emit: (type: SdkEventType, payload: unknown) => void }
    ) {
      eventState.lastEvents = createEventsForEmitter(eventEmitter);
    }
  },
}));

describe('GossipSdk lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    protocolMock.createMessageProtocolMock.mockReturnValue({
      fetchMessages: vi.fn(),
      sendMessage: vi.fn(),
      sendAnnouncement: vi.fn(),
      fetchAnnouncements: vi.fn(),
      fetchPublicKeyByUserId: vi.fn(),
      postPublicKey: vi.fn(),
      changeNode: vi.fn(),
    });
    eventState.lastEvents = null;

    sdk = new GossipSdk();
  });

  it('initializes once and exposes auth service', async () => {
    await sdk.init({});
    expect(sdk.isInitialized).toBe(true);
    expect(() => sdk.auth).not.toThrow();
  });

  it('throws on openSession before init', async () => {
    await expect(sdk.openSession({ mnemonic: 'test words' })).rejects.toThrow(
      'SDK not initialized'
    );
  });

  it('opens and closes session with getters wired', async () => {
    await sdk.init({});
    await sdk.openSession({ mnemonic: 'test words' });

    expect(sdk.isSessionOpen).toBe(true);
    expect(sdk.userIdBytes).toBeInstanceOf(Uint8Array);
    expect(sdk.userIdBytes.length).toBe(32);
    expect(sdk.publicKeys).toBeDefined();

    await sdk.closeSession();
    expect(sdk.isSessionOpen).toBe(false);
    expect(() => sdk.messages).toThrow('No session open');
  });

  it('restores encrypted session when provided', async () => {
    const mnemonic = 'test words long enough to generate an encryption key';
    const encryptionKey = await generateEncryptionKeyFromSeed(
      mnemonic,
      new Uint8Array(32).fill(0)
    );

    await sdk.init({});
    await sdk.openSession({
      mnemonic,
    });

    const encryptedSession = sdk.getEncryptedSession();
    await sdk.closeSession();

    await sdk.openSession({
      mnemonic,
      encryptedSession,
      encryptionKey,
    });
  });

  it('throws an error when encryptedSession cannot be loaded with the provided encryptionKey', async () => {
    const mnemonic = 'test words long enough to generate an encryption key';

    await sdk.init({});
    await sdk.openSession({
      mnemonic,
    });

    const encryptedSession = sdk.getEncryptedSession();

    await sdk.closeSession();

    await expect(
      sdk.openSession({
        mnemonic,
        encryptedSession,
        encryptionKey: { keyId: 'bad-key' } as unknown as EncryptionKey,
      })
    ).rejects.toThrow(
      'Failed to load encrypted session. Please provide a valid encryptedSession and encryptionKey.'
    );
  });

  it('bridges message events to sdk.on handlers', async () => {
    const handler = vi.fn();

    await sdk.init({});
    sdk.on(SdkEventType.MESSAGE_RECEIVED, handler);
    await sdk.openSession({ mnemonic: 'test words' });

    eventState.lastEvents?.onMessageReceived?.({ id: 1 });
    expect(handler).toHaveBeenCalledWith({ id: 1 });
  });
});
