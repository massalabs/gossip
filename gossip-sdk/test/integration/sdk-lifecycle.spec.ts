/**
 * GossipSdk lifecycle tests
 *
 * Uses real WASM SessionModule with real crypto.
 * Only mocks network-dependent protocols (auth, message).
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { EncryptionKey } from '../../src/wasm/encryption';
import { UserPublicKeys, UserSecretKeys } from '../../src/wasm/bindings';
import { GossipSdk, SdkEventType, SdkStatus } from '../../src/gossip';
import { clearAllTables, getTestStorageConfig } from '../testDb';
import { generateMnemonic } from '../../src/crypto/bip39';
import { MockMessageProtocol } from '../mocks';
import { PUBLIC_KEY_REPUBLISH_INTERVAL_MS } from '../../src/services/auth';
import { makeUserProfile } from '../helpers/factories';
import {
  configureLogging,
  resetLoggingForTests,
  setLogSinks,
  type LogSink,
} from '../../src/utils/logs';

vi.mock('../../src/api/messageProtocol', () => ({
  createMessageProtocol: () => new MockMessageProtocol(),
}));

const postPublicKey = vi.hoisted(() => vi.fn().mockResolvedValue('ok'));

vi.mock('../../src/api/authProtocol', () => ({
  createAuthProtocol: () => ({
    fetchPublicKeyByUserId: vi.fn().mockRejectedValue(new Error('not found')),
    postPublicKey,
  }),
}));

describe('GossipSdk lifecycle', () => {
  let sdk: GossipSdk;
  const emittedWarnings: unknown[] = [];
  const testSink: LogSink = (level, message) => {
    if (level === 'warn') {
      emittedWarnings.push(message);
    }
  };

  beforeEach(async () => {
    await clearAllTables();
    vi.clearAllMocks();
    emittedWarnings.length = 0;
    configureLogging({ enabled: true, minLevel: 'debug', persist: false });
    setLogSinks([testSink]);
    sdk = new GossipSdk();
  });

  afterEach(async () => {
    try {
      await sdk.closeSession();
    } catch {
      // may not be open
    }
    resetLoggingForTests();
  });

  it('owns an authorized portable import through terminal installation', async () => {
    let authorized = true;
    const connection = {
      isSecureStorage: true,
      storageState: 'locked' as const,
      secureStorageBeginPortableImport: vi.fn().mockResolvedValue(undefined),
      secureStoragePushPortableImportChunk: vi
        .fn()
        .mockResolvedValue(undefined),
      secureStorageValidatePortableImport: vi.fn().mockResolvedValue(undefined),
      secureStorageAuthenticatePortableImportCandidate: vi
        .fn()
        .mockResolvedValue({
          userId:
            'gossip1ywzkutgadznd0509tsl4gs4xjvsudhzgjuxc46ytngvq0lacx5es2xyz5s',
          username: 'Alice',
          avatar: null,
          createdAtMs: 1,
        }),
      secureStorageBeginPortableOuterMigration: vi
        .fn()
        .mockResolvedValue(undefined),
      secureStorageAdmitPortableOuterMigrationPassword: vi
        .fn()
        .mockResolvedValue(undefined),
      secureStorageFinishPortableOuterMigration: vi
        .fn()
        .mockResolvedValue(undefined),
      secureStorageInstallPortableImport: vi.fn().mockResolvedValue(undefined),
      secureStorageAbortPortableImport: vi.fn().mockResolvedValue(undefined),
    };
    const internals = sdk as unknown as {
      state: { status: SdkStatus };
      _conn: typeof connection;
    };
    internals.state = { status: SdkStatus.INITIALIZED };
    internals._conn = connection;

    const candidate = await sdk.beginPortableImport(() => authorized);
    const chunk = new Uint8Array([1, 2, 3]);
    await candidate.push(chunk);
    await candidate.finishValidation();
    await expect(
      candidate.authenticate(new Uint8Array([4]))
    ).resolves.toMatchObject({
      username: 'Alice',
    });
    const first = new Uint8Array([5]);
    const second = new Uint8Array([6]);
    await candidate.install(async admit => {
      await admit(first);
      await admit(second);
    });

    expect(
      connection.secureStorageAdmitPortableOuterMigrationPassword.mock.calls
    ).toEqual([[first], [second]]);
    await expect(sdk.beginPortableImport(() => true)).rejects.toThrow(
      'already active or completed'
    );
    await expect(sdk.secureStorageUnlock('password')).rejects.toThrow(
      'runtime ended for portable import'
    );
    authorized = false;
  });

  it('retains a sealed candidate for install retry without readmitting passwords', async () => {
    const installError = new Error('commit failed');
    const connection = {
      isSecureStorage: true,
      storageState: 'locked' as const,
      secureStorageBeginPortableImport: vi.fn().mockResolvedValue(undefined),
      secureStorageValidatePortableImport: vi.fn().mockResolvedValue(undefined),
      secureStorageBeginPortableOuterMigration: vi
        .fn()
        .mockResolvedValue(undefined),
      secureStorageAdmitPortableOuterMigrationPassword: vi
        .fn()
        .mockResolvedValue(undefined),
      secureStorageFinishPortableOuterMigration: vi
        .fn()
        .mockResolvedValue(undefined),
      secureStorageInstallPortableImport: vi
        .fn()
        .mockRejectedValueOnce(installError)
        .mockResolvedValueOnce(undefined),
      secureStorageAbortPortableImport: vi.fn().mockResolvedValue(undefined),
    };
    const internals = sdk as unknown as {
      state: { status: SdkStatus };
      _conn: typeof connection;
    };
    internals.state = { status: SdkStatus.INITIALIZED };
    internals._conn = connection;
    const candidate = await sdk.beginPortableImport(() => true);
    await candidate.finishValidation();
    const admitPasswords = vi.fn(
      async (admit: (value: Uint8Array) => Promise<void>) => {
        await admit(new Uint8Array([9]));
      }
    );

    await expect(candidate.install(admitPasswords)).rejects.toBe(installError);
    await expect(candidate.install(admitPasswords)).resolves.toBeUndefined();
    expect(admitPasswords).toHaveBeenCalledTimes(1);
    expect(
      connection.secureStorageFinishPortableOuterMigration
    ).toHaveBeenCalledTimes(1);
    expect(connection.secureStorageInstallPortableImport).toHaveBeenCalledTimes(
      2
    );
  });

  it('revokes an active portable candidate when authorization disappears', async () => {
    let authorized = true;
    const connection = {
      isSecureStorage: true,
      storageState: 'locked' as const,
      secureStorageBeginPortableImport: vi.fn().mockResolvedValue(undefined),
      secureStorageAbortPortableImport: vi
        .fn()
        .mockRejectedValueOnce(new Error('cleanup failed'))
        .mockResolvedValueOnce(undefined),
    };
    const internals = sdk as unknown as {
      state: { status: SdkStatus };
      _conn: typeof connection;
    };
    internals.state = { status: SdkStatus.INITIALIZED };
    internals._conn = connection;
    const candidate = await sdk.beginPortableImport(() => authorized);
    authorized = false;

    await expect(candidate.push(new Uint8Array([1]))).rejects.toThrow(
      'not currently authorized'
    );
    expect(connection.secureStorageAbortPortableImport).toHaveBeenCalledOnce();
    await expect(candidate.abort()).resolves.toBeUndefined();
    expect(connection.secureStorageAbortPortableImport).toHaveBeenCalledTimes(
      2
    );
  });

  it('awaits fire-and-forget password admission before finalization', async () => {
    const admissionError = new Error('admission failed');
    const connection = {
      isSecureStorage: true,
      storageState: 'locked' as const,
      secureStorageBeginPortableImport: vi.fn().mockResolvedValue(undefined),
      secureStorageValidatePortableImport: vi.fn().mockResolvedValue(undefined),
      secureStorageBeginPortableOuterMigration: vi
        .fn()
        .mockResolvedValue(undefined),
      secureStorageAdmitPortableOuterMigrationPassword: vi
        .fn()
        .mockRejectedValue(admissionError),
      secureStorageFinishPortableOuterMigration: vi
        .fn()
        .mockResolvedValue(undefined),
      secureStorageAbortPortableImport: vi.fn().mockResolvedValue(undefined),
    };
    const internals = sdk as unknown as {
      state: { status: SdkStatus };
      _conn: typeof connection;
    };
    internals.state = { status: SdkStatus.INITIALIZED };
    internals._conn = connection;
    const candidate = await sdk.beginPortableImport(() => true);
    await candidate.finishValidation();

    await expect(
      candidate.install(admit => {
        void admit(new Uint8Array([7]));
      })
    ).rejects.toMatchObject({
      name: 'PortableImportTerminalError',
      cause: admissionError,
    });
    expect(
      connection.secureStorageFinishPortableOuterMigration
    ).not.toHaveBeenCalled();
    expect(connection.secureStorageAbortPortableImport).toHaveBeenCalledOnce();
  });

  it('latches authorization denial across password-admission retries', async () => {
    let authorized = true;
    const connection = {
      isSecureStorage: true,
      storageState: 'locked' as const,
      secureStorageBeginPortableImport: vi.fn().mockResolvedValue(undefined),
      secureStorageValidatePortableImport: vi.fn().mockResolvedValue(undefined),
      secureStorageBeginPortableOuterMigration: vi
        .fn()
        .mockResolvedValue(undefined),
      secureStorageAdmitPortableOuterMigrationPassword: vi
        .fn()
        .mockResolvedValue(undefined),
      secureStorageAbortPortableImport: vi.fn().mockResolvedValue(undefined),
    };
    const internals = sdk as unknown as {
      state: { status: SdkStatus };
      _conn: typeof connection;
    };
    internals.state = { status: SdkStatus.INITIALIZED };
    internals._conn = connection;
    const candidate = await sdk.beginPortableImport(() => authorized);
    await candidate.finishValidation();

    await expect(
      candidate.install(async admit => {
        authorized = false;
        await expect(admit(new Uint8Array([1]))).rejects.toThrow(
          'not currently authorized'
        );
        authorized = true;
        await admit(new Uint8Array([2]));
      })
    ).rejects.toMatchObject({ name: 'PortableImportTerminalError' });
    expect(
      connection.secureStorageAdmitPortableOuterMigrationPassword
    ).not.toHaveBeenCalled();
    expect(connection.secureStorageAbortPortableImport).toHaveBeenCalledOnce();
  });

  it('rejects installation without a successfully admitted account', async () => {
    const connection = {
      isSecureStorage: true,
      storageState: 'locked' as const,
      secureStorageBeginPortableImport: vi.fn().mockResolvedValue(undefined),
      secureStorageValidatePortableImport: vi.fn().mockResolvedValue(undefined),
      secureStorageBeginPortableOuterMigration: vi
        .fn()
        .mockResolvedValue(undefined),
      secureStorageFinishPortableOuterMigration: vi
        .fn()
        .mockResolvedValue(undefined),
      secureStorageAbortPortableImport: vi.fn().mockResolvedValue(undefined),
    };
    const internals = sdk as unknown as {
      state: { status: SdkStatus };
      _conn: typeof connection;
    };
    internals.state = { status: SdkStatus.INITIALIZED };
    internals._conn = connection;
    const candidate = await sdk.beginPortableImport(() => true);
    await candidate.finishValidation();

    await expect(candidate.install(() => undefined)).rejects.toMatchObject({
      name: 'PortableImportTerminalError',
    });
    expect(
      connection.secureStorageFinishPortableOuterMigration
    ).not.toHaveBeenCalled();
    expect(connection.secureStorageAbortPortableImport).toHaveBeenCalledOnce();
  });

  it('serializes concurrent portable-import startup attempts', async () => {
    let release: (() => void) | undefined;
    const connection = {
      isSecureStorage: true,
      storageState: 'locked' as const,
      secureStorageBeginPortableImport: vi.fn(
        () =>
          new Promise<void>(resolve => {
            release = resolve;
          })
      ),
      secureStorageAbortPortableImport: vi.fn().mockResolvedValue(undefined),
    };
    const internals = sdk as unknown as {
      state: { status: SdkStatus };
      _conn: typeof connection;
    };
    internals.state = { status: SdkStatus.INITIALIZED };
    internals._conn = connection;
    const first = sdk.beginPortableImport(() => true);
    await vi.waitFor(() =>
      expect(connection.secureStorageBeginPortableImport).toHaveBeenCalledOnce()
    );
    await expect(sdk.beginPortableImport(() => true)).rejects.toThrow(
      'startup is already active'
    );
    release?.();
    const candidate = await first;
    await candidate.abort();
    expect(connection.secureStorageBeginPortableImport).toHaveBeenCalledOnce();
  });

  it('retries startup cleanup before rechecking authorization', async () => {
    let authorized = true;
    let release: (() => void) | undefined;
    const connection = {
      isSecureStorage: true,
      storageState: 'locked' as const,
      secureStorageBeginPortableImport: vi.fn(
        () =>
          new Promise<void>(resolve => {
            release = resolve;
          })
      ),
      secureStorageAbortPortableImport: vi
        .fn()
        .mockRejectedValueOnce(new Error('cleanup failed'))
        .mockResolvedValueOnce(undefined),
    };
    const internals = sdk as unknown as {
      state: { status: SdkStatus };
      _conn: typeof connection;
    };
    internals.state = { status: SdkStatus.INITIALIZED };
    internals._conn = connection;

    const beginning = sdk.beginPortableImport(() => authorized);
    await vi.waitFor(() =>
      expect(connection.secureStorageBeginPortableImport).toHaveBeenCalledOnce()
    );
    authorized = false;
    release?.();
    await expect(beginning).rejects.toThrow('cleanup failed');
    await expect(sdk.beginPortableImport(() => false)).rejects.toThrow(
      'not currently authorized'
    );
    expect(connection.secureStorageAbortPortableImport).toHaveBeenCalledTimes(
      2
    );
    expect(connection.secureStorageBeginPortableImport).toHaveBeenCalledOnce();
  });

  it('retains startup cleanup when authorization checking throws', async () => {
    const authorizationError = new Error('authorization unavailable');
    let checks = 0;
    const connection = {
      isSecureStorage: true,
      storageState: 'locked' as const,
      secureStorageBeginPortableImport: vi.fn().mockResolvedValue(undefined),
      secureStorageAbortPortableImport: vi
        .fn()
        .mockRejectedValueOnce(new Error('cleanup failed'))
        .mockResolvedValueOnce(undefined),
    };
    const internals = sdk as unknown as {
      state: { status: SdkStatus };
      _conn: typeof connection;
    };
    internals.state = { status: SdkStatus.INITIALIZED };
    internals._conn = connection;

    await expect(
      sdk.beginPortableImport(() => {
        checks += 1;
        if (checks === 1) return true;
        throw authorizationError;
      })
    ).rejects.toBe(authorizationError);
    await expect(sdk.beginPortableImport(() => false)).rejects.toThrow(
      'not currently authorized'
    );
    expect(connection.secureStorageAbortPortableImport).toHaveBeenCalledTimes(
      2
    );
    expect(connection.secureStorageBeginPortableImport).toHaveBeenCalledOnce();
  });

  it('does not return a preview when authorization changes during authentication', async () => {
    let authorized = true;
    let release: ((value: { username: string }) => void) | undefined;
    const connection = {
      isSecureStorage: true,
      storageState: 'locked' as const,
      secureStorageBeginPortableImport: vi.fn().mockResolvedValue(undefined),
      secureStorageValidatePortableImport: vi.fn().mockResolvedValue(undefined),
      secureStorageAuthenticatePortableImportCandidate: vi.fn(
        () =>
          new Promise<{ username: string }>(resolve => {
            release = resolve;
          })
      ),
      secureStorageAbortPortableImport: vi.fn().mockResolvedValue(undefined),
    };
    const internals = sdk as unknown as {
      state: { status: SdkStatus };
      _conn: typeof connection;
    };
    internals.state = { status: SdkStatus.INITIALIZED };
    internals._conn = connection;
    const candidate = await sdk.beginPortableImport(() => authorized);
    await candidate.finishValidation();
    const authenticating = candidate.authenticate(new Uint8Array([1]));
    await vi.waitFor(() =>
      expect(
        connection.secureStorageAuthenticatePortableImportCandidate
      ).toHaveBeenCalledOnce()
    );
    authorized = false;
    release?.({ username: 'must not escape' });

    await expect(authenticating).rejects.toThrow('not currently authorized');
    expect(connection.secureStorageAbortPortableImport).toHaveBeenCalledOnce();
  });

  it('initializes once and exposes auth service', async () => {
    await sdk.init({ storage: getTestStorageConfig() });
    expect(sdk.isInitialized).toBe(true);
    expect(() => sdk.auth).not.toThrow();

    await sdk.init({ storage: getTestStorageConfig() });
    expect(emittedWarnings.length).toBeGreaterThan(0);
  });

  it('invalidates query readiness before a retryable lock failure', async () => {
    const lockError = new Error('lock flush failed');
    const connection = {
      isOpen: true,
      isSecureStorage: true,
      storageState: 'unlocked' as const,
      secureStorageLock: vi.fn().mockImplementationOnce(async () => {
        connection.isOpen = false;
        throw lockError;
      }),
    };
    const internals = sdk as unknown as {
      state: { status: SdkStatus };
      _conn: typeof connection;
      _queries: object | null;
      _profile: object | null;
    };
    internals.state = { status: SdkStatus.INITIALIZED };
    internals._conn = connection;
    internals._queries = {};
    internals._profile = {};
    expect(sdk.dbReady).toBe(true);

    await expect(sdk.secureStorageLock()).rejects.toBe(lockError);

    expect(sdk.storageState).toBe('unlocked');
    expect(sdk.dbReady).toBe(false);
    expect(() => sdk.queries).toThrow();
    expect(() => sdk.profiles).toThrow();

    connection.secureStorageLock.mockResolvedValueOnce(undefined);
    await expect(sdk.secureStorageLock()).resolves.toBeUndefined();
  });

  it('keeps committed profile mutations successful when publication bookkeeping fails', async () => {
    await sdk.init({ storage: getTestStorageConfig() });
    const publicationError = new Error('timestamp persistence failed');
    const internals = sdk as unknown as {
      _auth: {
        persistPendingPublicationTimestamp: (
          userId: string
        ) => Promise<boolean>;
      };
    };
    const persistTimestamp = vi
      .spyOn(internals._auth, 'persistPendingPublicationTimestamp')
      .mockRejectedValue(publicationError);
    const emittedErrors: Array<{ error: Error; context: string }> = [];
    sdk.on(SdkEventType.ERROR, payload => emittedErrors.push(payload));
    const savedProfile = makeUserProfile();
    const createdProfile = makeUserProfile({
      userId:
        'gossip1dp6gk5zp0f95g23av0aa0j926jknw4fk5ng77w4v92dxcjcwz9dsv5q6th',
      username: 'created profile',
    });

    await expect(sdk.profiles.save(savedProfile)).resolves.toBeUndefined();
    await expect(
      sdk.profiles.createOrUpdate(
        createdProfile.username,
        createdProfile.userId,
        createdProfile.security,
        createdProfile.session
      )
    ).resolves.toMatchObject({ userId: createdProfile.userId });
    await expect(
      sdk.profiles.createOrUpdate(
        createdProfile.username,
        createdProfile.userId,
        createdProfile.security,
        new Uint8Array([4, 5, 6])
      )
    ).resolves.toMatchObject({ userId: createdProfile.userId });

    await expect(sdk.profiles.get(savedProfile.userId)).resolves.toMatchObject({
      username: savedProfile.username,
    });
    await expect(
      sdk.profiles.get(createdProfile.userId)
    ).resolves.toMatchObject({ session: new Uint8Array([4, 5, 6]) });
    expect(persistTimestamp).toHaveBeenCalledTimes(3);
    expect(emittedErrors).toEqual([
      {
        error: publicationError,
        context: 'persistPublicKeyPublicationTimestamp',
      },
      {
        error: publicationError,
        context: 'persistPublicKeyPublicationTimestamp',
      },
      {
        error: publicationError,
        context: 'persistPublicKeyPublicationTimestamp',
      },
    ]);
  });

  it('throws on openSession before init', async () => {
    await expect(
      sdk.openSession({ mnemonic: generateMnemonic() })
    ).rejects.toThrow('SDK not initialized');
  });

  it('rejects unknown identity versions before key or session work', async () => {
    await sdk.init({ storage: getTestStorageConfig() });
    const deriveSpy = vi.spyOn(EncryptionKey, 'from_seed');

    await expect(
      sdk.openSession({
        mnemonic: generateMnemonic(),
        identityDerivationVersion: 2,
      })
    ).rejects.toThrow('Unsupported identity derivation version');
    expect(deriveSpy).not.toHaveBeenCalled();
    expect(sdk.isSessionOpen).toBe(false);
    deriveSpy.mockRestore();
  });

  it('opens and closes session with getters wired', async () => {
    await sdk.init({ storage: getTestStorageConfig() });
    await sdk.openSession({ mnemonic: generateMnemonic() });

    expect(sdk.isSessionOpen).toBe(true);
    expect(sdk.userIdBytes).toBeInstanceOf(Uint8Array);
    expect(sdk.userIdBytes.length).toBe(32);
    expect(sdk.publicKeys).toBeDefined();

    await sdk.closeSession();
    expect(sdk.isSessionOpen).toBe(false);
    expect(() => sdk.messages).toThrow('No session open');
  });

  it('disposes identity wrappers and its derived key on normal close', async () => {
    await sdk.init({ storage: getTestStorageConfig() });
    const publicFree = vi.spyOn(UserPublicKeys.prototype, 'free');
    const secretFree = vi.spyOn(UserSecretKeys.prototype, 'free');
    const encryptionFree = vi.spyOn(EncryptionKey.prototype, 'free');

    try {
      await sdk.openSession({
        mnemonic: generateMnemonic(),
        autoStartPolling: false,
        publishPublicKey: false,
      });
      await sdk.closeSession();

      expect(publicFree).toHaveBeenCalledOnce();
      expect(secretFree).toHaveBeenCalledOnce();
      expect(encryptionFree).toHaveBeenCalledOnce();
    } finally {
      publicFree.mockRestore();
      secretFree.mockRestore();
      encryptionFree.mockRestore();
    }
  });

  it('disposes constructed identity state when session opening rejects', async () => {
    await sdk.init({ storage: getTestStorageConfig() });
    const publicFree = vi.spyOn(UserPublicKeys.prototype, 'free');
    const secretFree = vi.spyOn(UserSecretKeys.prototype, 'free');
    const encryptionFree = vi.spyOn(EncryptionKey.prototype, 'free');
    const internals = sdk as unknown as {
      resetStuckSendingMessages: (userId: string) => Promise<void>;
    };
    const reset = vi
      .spyOn(internals, 'resetStuckSendingMessages')
      .mockRejectedValue(new Error('database reset failed'));

    try {
      await expect(
        sdk.openSession({
          mnemonic: generateMnemonic(),
          autoStartPolling: false,
        })
      ).rejects.toThrow('database reset failed');

      expect(sdk.isSessionOpen).toBe(false);
      expect(postPublicKey).not.toHaveBeenCalled();
      expect(publicFree).toHaveBeenCalledOnce();
      expect(secretFree).toHaveBeenCalledOnce();
      expect(encryptionFree).toHaveBeenCalledOnce();
    } finally {
      reset.mockRestore();
      publicFree.mockRestore();
      secretFree.mockRestore();
      encryptionFree.mockRestore();
    }
  });

  it('frees an internally derived key when session validation rejects', async () => {
    await sdk.init({ storage: getTestStorageConfig() });
    const encryptionFree = vi.spyOn(EncryptionKey.prototype, 'free');

    try {
      await expect(
        sdk.openSession({
          mnemonic: generateMnemonic(),
          encryptedSession: new Uint8Array([1, 2, 3]),
          autoStartPolling: false,
        })
      ).rejects.toThrow('Failed to load encrypted session');
      expect(encryptionFree).toHaveBeenCalledOnce();
    } finally {
      encryptionFree.mockRestore();
    }
  });

  it('can defer public-key publication until a later real login', async () => {
    const mnemonic = generateMnemonic();
    await sdk.init({ storage: getTestStorageConfig() });

    await sdk.openSession({
      mnemonic,
      autoStartPolling: false,
      publishPublicKey: false,
    });
    await Promise.resolve();
    expect(postPublicKey).not.toHaveBeenCalled();

    await sdk.closeSession();
    await sdk.openSession({ mnemonic, autoStartPolling: false });
    await vi.waitFor(() => expect(postPublicKey).toHaveBeenCalledOnce());
  });

  it('unrefs publication timers in Node without cancelling them', async () => {
    await sdk.init({ storage: getTestStorageConfig() });
    await sdk.openSession({
      mnemonic: generateMnemonic(),
      autoStartPolling: false,
      publishPublicKey: false,
    });
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    try {
      sdk.startPublicKeyPublication();
      await vi.waitFor(() => {
        const timerIndex = setTimeoutSpy.mock.calls.findIndex(
          ([, delay]) => delay === 60_000
        );
        expect(timerIndex).toBeGreaterThanOrEqual(0);

        const timer = setTimeoutSpy.mock.results[timerIndex]?.value as {
          hasRef?: () => boolean;
        };
        expect(timer.hasRef?.()).toBe(false);
      });
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it('retries failed publication and republishes when refresh is due', async () => {
    await sdk.init({ storage: getTestStorageConfig() });
    await sdk.openSession({
      mnemonic: generateMnemonic(),
      autoStartPolling: false,
      publishPublicKey: false,
    });
    postPublicKey
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue('ok');
    vi.useFakeTimers();

    try {
      sdk.startPublicKeyPublication();
      await vi.waitFor(() => expect(postPublicKey).toHaveBeenCalledOnce());

      await vi.advanceTimersByTimeAsync(60_000);
      await vi.waitFor(() => expect(postPublicKey).toHaveBeenCalledTimes(2));

      await vi.advanceTimersByTimeAsync(PUBLIC_KEY_REPUBLISH_INTERVAL_MS);
      await vi.waitFor(() => expect(postPublicKey).toHaveBeenCalledTimes(3));
    } finally {
      await sdk.closeSession();
      vi.useRealTimers();
    }
  });

  it('restores encrypted session when provided', async () => {
    const mnemonic = generateMnemonic();

    await sdk.init({ storage: getTestStorageConfig() });
    await sdk.openSession({ mnemonic });

    const encryptedSession = sdk.getEncryptedSession();
    await sdk.closeSession();

    await sdk.openSession({
      mnemonic,
      encryptedSession,
    });
  });

  it('throws an error when encryptedSession cannot be loaded with the provided encryptionKey', async () => {
    const mnemonic = generateMnemonic();

    await sdk.init({ storage: getTestStorageConfig() });
    await sdk.openSession({ mnemonic });

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
});
