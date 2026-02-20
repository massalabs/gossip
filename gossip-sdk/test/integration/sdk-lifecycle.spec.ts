/**
 * GossipSdk lifecycle and event wiring tests
 *
 * Uses vi.mock() for SDK dependencies. When run after other test files,
 * the gossipSdk module may be cached with real implementations, so we
 * call vi.resetModules() in beforeEach to force a fresh import with mocks.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type EncryptionKey } from '../../src/wasm/encryption';
import { GossipSdk, SdkEventType } from '../../src/gossip';

const protocolMock = vi.hoisted(() => ({
  createMessageProtocolMock: vi.fn(),
}));

const eventState = vi.hoisted(() => ({
  // Stores the SdkEventEmitter passed to service constructors
  lastEmitter: null as {
    emit: (event: string, ...args: unknown[]) => void;
  } | null,
}));

const sessionMock = vi.hoisted(() => {
  const userIdBytes = new Uint8Array(32).fill(9);
  const userIdEncoded = 'gossip1testsessionuserid';
  const state = { lastSessionInstance: null as MockSession | null };

  class MockSession {
    userId = userIdBytes;
    userIdEncoded = userIdEncoded;
    ourPk = { key: 'pk' };
    load = vi.fn();
    cleanup = vi.fn();
    toEncryptedBlob = vi.fn().mockReturnValue(new Uint8Array([9]));
    private onPersist?: () => void;

    constructor(_keys: unknown, onPersist?: () => void) {
      this.onPersist = onPersist;
      state.lastSessionInstance = this;
    }

    emitPersist() {
      this.onPersist?.();
    }
  }

  return { MockSession, state, userIdBytes, userIdEncoded };
});

vi.mock('../../src/api/messageProtocol', () => ({
  createMessageProtocol: () => protocolMock.createMessageProtocolMock(),
}));

vi.mock('../../src/wasm/loader', () => ({
  startWasmInitialization: vi.fn(),
  ensureWasmInitialized: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/wasm/userKeys', () => ({
  generateUserKeys: vi.fn().mockResolvedValue({}),
}));

vi.mock('../../src/wasm/session', async () => {
  return {
    SessionModule: sessionMock.MockSession,
  };
});

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
    skipHistoricalAnnouncements = vi.fn().mockResolvedValue(undefined);
    constructor(
      _protocol: unknown,
      _session: unknown,
      events: typeof eventState.lastEmitter
    ) {
      eventState.lastEmitter = events ?? null;
    }
  },
}));

vi.mock('../../src/services/message', () => ({
  MessageService: class {
    sendMessage = vi.fn();
    fetchMessages = vi.fn();
    processSendQueueForContact = vi.fn();
    getPendingSendCount = vi.fn().mockResolvedValue(0);
    findMessageByMsgId = vi.fn();
    setRefreshService = vi.fn();

    constructor(
      _protocol: unknown,
      _session: unknown,
      _discussion: unknown,
      events: typeof eventState.lastEmitter
    ) {
      eventState.lastEmitter = events ?? null;
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
      _announcement: unknown,
      _session: unknown,
      events: typeof eventState.lastEmitter
    ) {
      eventState.lastEmitter = events ?? null;
    }
  },
}));

vi.mock('../../src/sqlite', () => ({
  initDb: vi.fn().mockResolvedValue(undefined),
  getSqliteDb: vi.fn(),
  closeSqlite: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/queries', () => ({
  getMessageById: vi.fn(),
  getMessagesByOwnerAndContact: vi.fn().mockResolvedValue([]),
  getMessagesByStatus: vi.fn().mockResolvedValue([]),
  updateMessageById: vi.fn().mockResolvedValue(undefined),
  getDiscussionsByOwner: vi.fn().mockResolvedValue([]),
  getDiscussionByOwnerAndContact: vi.fn().mockResolvedValue(undefined),
  getDiscussionsByOwnerAndStatus: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../src/contacts', () => ({
  getContacts: vi.fn().mockResolvedValue([]),
  getContact: vi.fn(),
  addContact: vi.fn(),
  updateContactName: vi.fn(),
  deleteContact: vi.fn(),
}));

vi.mock('../../src/services/refresh', () => ({
  RefreshService: class {
    stateUpdate = vi.fn();
    constructor(
      _message: unknown,
      _discussion: unknown,
      _announcement: unknown,
      _session: unknown,
      events: typeof eventState.lastEmitter
    ) {
      eventState.lastEmitter = events ?? null;
    }
  },
}));

describe('GossipSdk lifecycle', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    protocolMock.createMessageProtocolMock.mockReturnValue({
      fetchMessages: vi.fn(),
      sendMessage: vi.fn(),
      sendAnnouncement: vi.fn(),
      fetchAnnouncements: vi.fn(),
      fetchBulletinCounter: vi.fn().mockResolvedValue('0'),
      changeNode: vi.fn(),
    });
    sessionMock.state.lastSessionInstance = null;
    eventState.lastEmitter = null;
  });

  it('initializes once and exposes auth service', async () => {
    const sdk = new GossipSdk();

    await sdk.init({});
    expect(sdk.isInitialized).toBe(true);
    expect(() => sdk.auth).not.toThrow();

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await sdk.init({});
    expect(warnSpy).toHaveBeenCalled();
  });

  it('throws on openSession before init', async () => {
    const sdk = new GossipSdk();

    await expect(sdk.openSession({ mnemonic: 'test words' })).rejects.toThrow(
      'SDK not initialized'
    );
  });

  it('opens and closes session with getters wired', async () => {
    const sdk = new GossipSdk();

    await sdk.init({});
    await sdk.openSession({ mnemonic: 'test words' });

    expect(sdk.isSessionOpen).toBe(true);
    expect(sdk.userIdBytes).toBeInstanceOf(Uint8Array);
    expect(sdk.userIdBytes.length).toBe(32);
    expect(sdk.publicKeys).toBeDefined();

    await sdk.closeSession();
    expect(sdk.isSessionOpen).toBe(false);
    expect(sessionMock.state.lastSessionInstance?.cleanup).toHaveBeenCalled();
    expect(() => sdk.messages).toThrow('No session open');
  });

  it('restores encrypted session when provided', async () => {
    const sdk = new GossipSdk();
    const encryptedSession = new Uint8Array([1, 2, 3]);
    const encryptionKey = {} as EncryptionKey;

    await sdk.init({});
    await sdk.openSession({
      mnemonic: 'test words',
      encryptedSession,
      encryptionKey,
    });

    expect(sessionMock.state.lastSessionInstance?.load).toHaveBeenCalled();
  });

  it('persists session via onPersist callback', async () => {
    const sdk = new GossipSdk();
    const onPersist = vi.fn().mockResolvedValue(undefined);
    const persistEncryptionKey = {} as EncryptionKey;

    await sdk.init({});
    await sdk.openSession({
      mnemonic: 'test words',
      onPersist,
      persistEncryptionKey,
    });

    sessionMock.state.lastSessionInstance?.emitPersist();
    expect(onPersist).toHaveBeenCalledWith(
      new Uint8Array([9]),
      persistEncryptionKey
    );
  });

  it('bridges message events to sdk.on handlers', async () => {
    const sdk = new GossipSdk();
    const handler = vi.fn();

    await sdk.init({});
    sdk.on(SdkEventType.MESSAGE_RECEIVED, handler);
    await sdk.openSession({ mnemonic: 'test words' });

    eventState.lastEmitter?.emit(SdkEventType.MESSAGE_RECEIVED, { id: 1 });
    expect(handler).toHaveBeenCalledWith({ id: 1 });
  });
});

describe('GossipSdk.configurePersistence', () => {
  beforeEach(() => {
    vi.resetModules();
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
    sessionMock.state.lastSessionInstance = null;
    eventState.lastEmitter = null;
  });

  it('throws if called before session is opened', async () => {
    const sdk = new GossipSdk();
    const onPersist = vi.fn();
    const encryptionKey = {} as EncryptionKey;

    await sdk.init({});

    expect(() => sdk.configurePersistence(encryptionKey, onPersist)).toThrow(
      'No session open'
    );
  });

  it('configures persistence after session is opened without initial onPersist', async () => {
    const sdk = new GossipSdk();
    const onPersist = vi.fn().mockResolvedValue(undefined);
    const encryptionKey = {} as EncryptionKey;

    await sdk.init({});

    await sdk.openSession({ mnemonic: 'test words' });

    sdk.configurePersistence(encryptionKey, onPersist);

    sessionMock.state.lastSessionInstance?.emitPersist();

    expect(onPersist).toHaveBeenCalledWith(new Uint8Array([9]), encryptionKey);
  });

  it('replaces existing onPersist callback when reconfigured', async () => {
    const sdk = new GossipSdk();
    const originalOnPersist = vi.fn().mockResolvedValue(undefined);
    const newOnPersist = vi.fn().mockResolvedValue(undefined);
    const originalKey = { original: true } as unknown as EncryptionKey;
    const newKey = { new: true } as unknown as EncryptionKey;

    await sdk.init({});

    await sdk.openSession({
      mnemonic: 'test words',
      onPersist: originalOnPersist,
      persistEncryptionKey: originalKey,
    });

    sdk.configurePersistence(newKey, newOnPersist);

    sessionMock.state.lastSessionInstance?.emitPersist();

    expect(originalOnPersist).not.toHaveBeenCalled();
    expect(newOnPersist).toHaveBeenCalledWith(new Uint8Array([9]), newKey);
  });

  it('ensures persistence is called with correct encryption key', async () => {
    const sdk = new GossipSdk();
    const onPersist = vi.fn().mockResolvedValue(undefined);
    const specificKey = { keyId: 'test-key-123' } as unknown as EncryptionKey;

    await sdk.init({});
    await sdk.openSession({ mnemonic: 'test words' });

    sdk.configurePersistence(specificKey, onPersist);
    sessionMock.state.lastSessionInstance?.emitPersist();

    expect(onPersist).toHaveBeenCalledWith(expect.any(Uint8Array), specificKey);
  });
});
