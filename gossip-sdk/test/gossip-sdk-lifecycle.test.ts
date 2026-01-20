/**
 * GossipSdk lifecycle and event wiring tests
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GossipDatabase } from '../src/db';
import type { EncryptionKey } from '../src/wasm/encryption';

const protocolMock = vi.hoisted(() => ({
  createMessageProtocolMock: vi.fn(),
}));

const eventState = vi.hoisted(() => ({
  lastEvents: null as {
    onMessageReceived?: (message: unknown) => void;
    onDiscussionRequest?: (...args: unknown[]) => void;
    onError?: (...args: unknown[]) => void;
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

vi.mock('../src/api/messageProtocol', () => ({
  createMessageProtocol: () => protocolMock.createMessageProtocolMock(),
}));

vi.mock('../src/wasm/loader', () => ({
  startWasmInitialization: vi.fn(),
  ensureWasmInitialized: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/wasm/userKeys', () => ({
  generateUserKeys: vi.fn().mockResolvedValue({}),
}));

vi.mock('../src/wasm/session', async () => {
  return {
    SessionModule: sessionMock.MockSession,
  };
});

vi.mock('../src/services/auth', () => ({
  AuthService: class {
    constructor() {}
  },
}));

vi.mock('../src/services/announcement', () => ({
  AnnouncementService: class {
    constructor(
      _db: unknown,
      _protocol: unknown,
      _session: unknown,
      events: typeof eventState.lastEvents
    ) {
      eventState.lastEvents = events ?? null;
    }
  },
}));

vi.mock('../src/services/message', () => ({
  MessageService: class {
    sendMessage = vi.fn();
    fetchMessages = vi.fn();
    resendMessages = vi.fn();
    findMessageBySeeker = vi.fn();

    constructor(
      _db: unknown,
      _protocol: unknown,
      _session: unknown,
      events: typeof eventState.lastEvents
    ) {
      eventState.lastEvents = events ?? null;
    }
  },
}));

vi.mock('../src/services/discussion', () => ({
  DiscussionService: class {
    initialize = vi.fn();
    accept = vi.fn();
    renew = vi.fn();
    isStableState = vi.fn();
    constructor(
      _db: unknown,
      _announcement: unknown,
      _session: unknown,
      events: typeof eventState.lastEvents
    ) {
      eventState.lastEvents = events ?? null;
    }
  },
}));

vi.mock('../src/services/refresh', () => ({
  RefreshService: class {
    handleSessionRefresh = vi.fn();
    constructor(
      _db: unknown,
      _message: unknown,
      _session: unknown,
      events: typeof eventState.lastEvents
    ) {
      eventState.lastEvents = events ?? null;
    }
  },
}));

describe('GossipSdkImpl lifecycle', () => {
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
    sessionMock.state.lastSessionInstance = null;
    eventState.lastEvents = null;
  });

  it('initializes once and exposes auth service', async () => {
    const { GossipSdkImpl } = await import('../src/gossipSdk');
    const sdk = new GossipSdkImpl();

    await sdk.init({ db: new GossipDatabase() });
    expect(sdk.isInitialized).toBe(true);
    expect(() => sdk.auth).not.toThrow();

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await sdk.init({ db: new GossipDatabase() });
    expect(warnSpy).toHaveBeenCalled();
  });

  it('throws on openSession before init', async () => {
    const { GossipSdkImpl } = await import('../src/gossipSdk');
    const sdk = new GossipSdkImpl();

    await expect(sdk.openSession({ mnemonic: 'test words' })).rejects.toThrow(
      'SDK not initialized'
    );
  });

  it('opens and closes session with getters wired', async () => {
    const { GossipSdkImpl } = await import('../src/gossipSdk');
    const sdk = new GossipSdkImpl();

    await sdk.init({ db: new GossipDatabase() });
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
    const { GossipSdkImpl } = await import('../src/gossipSdk');
    const sdk = new GossipSdkImpl();
    const encryptedSession = new Uint8Array([1, 2, 3]);
    const encryptionKey = {} as EncryptionKey;

    await sdk.init({ db: new GossipDatabase() });
    await sdk.openSession({
      mnemonic: 'test words',
      encryptedSession,
      encryptionKey,
    });

    expect(sessionMock.state.lastSessionInstance?.load).toHaveBeenCalled();
  });

  it('persists session via onPersist callback', async () => {
    const { GossipSdkImpl } = await import('../src/gossipSdk');
    const sdk = new GossipSdkImpl();
    const onPersist = vi.fn().mockResolvedValue(undefined);
    const persistEncryptionKey = {} as EncryptionKey;

    await sdk.init({ db: new GossipDatabase() });
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
    const { GossipSdkImpl } = await import('../src/gossipSdk');
    const sdk = new GossipSdkImpl();
    const handler = vi.fn();

    await sdk.init({ db: new GossipDatabase() });
    sdk.on('message', handler);
    await sdk.openSession({ mnemonic: 'test words' });

    eventState.lastEvents?.onMessageReceived?.({ id: 1 });
    expect(handler).toHaveBeenCalledWith({ id: 1 });
  });
});

/**
 * Tests for configurePersistence method
 *
 * CRITICAL: These tests ensure session persistence can be configured AFTER
 * openSession() is called. This is essential for account creation flows where
 * we need to create the user profile before we can set up persistence.
 *
 * Bug prevented: Without configurePersistence, new accounts created with
 * openSession() (without onPersist) would never persist session state,
 * causing WAITING_SESSION issues after page reload.
 */
describe('GossipSdkImpl.configurePersistence', () => {
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
    sessionMock.state.lastSessionInstance = null;
    eventState.lastEvents = null;
  });

  it('throws if called before session is opened', async () => {
    const { GossipSdkImpl } = await import('../src/gossipSdk');
    const sdk = new GossipSdkImpl();
    const onPersist = vi.fn();
    const encryptionKey = {} as EncryptionKey;

    await sdk.init({ db: new GossipDatabase() });

    // Session not opened yet - should throw
    expect(() => sdk.configurePersistence(encryptionKey, onPersist)).toThrow(
      'No session open'
    );
  });

  it('configures persistence after session is opened without initial onPersist', async () => {
    const { GossipSdkImpl } = await import('../src/gossipSdk');
    const sdk = new GossipSdkImpl();
    const onPersist = vi.fn().mockResolvedValue(undefined);
    const encryptionKey = {} as EncryptionKey;

    await sdk.init({ db: new GossipDatabase() });

    // Open session WITHOUT onPersist (simulates account creation flow)
    await sdk.openSession({ mnemonic: 'test words' });

    // Configure persistence after profile is created
    sdk.configurePersistence(encryptionKey, onPersist);

    // Trigger persist event from session
    sessionMock.state.lastSessionInstance?.emitPersist();

    // Should have called the newly configured onPersist
    expect(onPersist).toHaveBeenCalledWith(new Uint8Array([9]), encryptionKey);
  });

  it('replaces existing onPersist callback when reconfigured', async () => {
    const { GossipSdkImpl } = await import('../src/gossipSdk');
    const sdk = new GossipSdkImpl();
    const originalOnPersist = vi.fn().mockResolvedValue(undefined);
    const newOnPersist = vi.fn().mockResolvedValue(undefined);
    const originalKey = { original: true } as unknown as EncryptionKey;
    const newKey = { new: true } as unknown as EncryptionKey;

    await sdk.init({ db: new GossipDatabase() });

    // Open session with initial persistence
    await sdk.openSession({
      mnemonic: 'test words',
      onPersist: originalOnPersist,
      persistEncryptionKey: originalKey,
    });

    // Reconfigure with new callback
    sdk.configurePersistence(newKey, newOnPersist);

    // Trigger persist
    sessionMock.state.lastSessionInstance?.emitPersist();

    // Only the new callback should be called
    expect(originalOnPersist).not.toHaveBeenCalled();
    expect(newOnPersist).toHaveBeenCalledWith(new Uint8Array([9]), newKey);
  });

  it('ensures persistence is called with correct encryption key', async () => {
    const { GossipSdkImpl } = await import('../src/gossipSdk');
    const sdk = new GossipSdkImpl();
    const onPersist = vi.fn().mockResolvedValue(undefined);
    const specificKey = { keyId: 'test-key-123' } as unknown as EncryptionKey;

    await sdk.init({ db: new GossipDatabase() });
    await sdk.openSession({ mnemonic: 'test words' });

    sdk.configurePersistence(specificKey, onPersist);
    sessionMock.state.lastSessionInstance?.emitPersist();

    // Verify the specific encryption key is passed
    expect(onPersist).toHaveBeenCalledWith(expect.any(Uint8Array), specificKey);
  });
});
