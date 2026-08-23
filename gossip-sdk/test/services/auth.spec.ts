/**
 * AuthService tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  AuthService,
  getPublicKeyErrorMessage,
  PUBLIC_KEY_NOT_FOUND_ERROR,
  PUBLIC_KEY_NOT_FOUND_MESSAGE,
  FAILED_TO_FETCH_ERROR,
  FAILED_TO_FETCH_MESSAGE,
  FAILED_TO_RETRIEVE_CONTACT_PUBLIC_KEY_ERROR,
} from '../../src/services/auth';
import type { IAuthProtocol } from '../../src/api/authProtocol';
import {
  UserPublicKeys,
  UserKeys,
  generate_user_keys,
} from '../../src/wasm/bindings';
import { encodeUserId } from '../../src/utils/userId';
import { encodeToBase64, decodeFromBase64 } from '../../src/utils/base64';
import { ensureWasmInitialized } from '../../src/wasm';
import { clearAllTables, getTestQueries } from '../testDb';
import { ProfileService } from '../../src/services/profile';
import { rowToUserProfile, type Queries } from '../../src/db/queries';
import { makeUserProfileRow } from '../helpers/factories';

function createMockAuthProtocol(
  overrides: Partial<IAuthProtocol> = {}
): IAuthProtocol {
  return {
    fetchPublicKeyByUserId: vi.fn().mockResolvedValue(''),
    postPublicKey: vi.fn().mockResolvedValue('hash'),
    ...overrides,
  };
}

describe('getPublicKeyErrorMessage', () => {
  it('should return specific message for "Public key not found" error', () => {
    const error = new Error(PUBLIC_KEY_NOT_FOUND_ERROR);
    const result = getPublicKeyErrorMessage(error);
    expect(result).toBe(PUBLIC_KEY_NOT_FOUND_MESSAGE);
  });

  it('should return specific message for "Failed to fetch" error', () => {
    const error = new Error(FAILED_TO_FETCH_ERROR);
    const result = getPublicKeyErrorMessage(error);
    expect(result).toBe(FAILED_TO_FETCH_MESSAGE);
  });

  it('should return generic message with error details for other errors', () => {
    const error = new Error('Network timeout');
    const result = getPublicKeyErrorMessage(error);
    expect(result).toContain(FAILED_TO_RETRIEVE_CONTACT_PUBLIC_KEY_ERROR);
    expect(result).toContain('Network timeout');
  });

  it('should handle non-Error objects', () => {
    const error = 'String error';
    const result = getPublicKeyErrorMessage(error);
    expect(result).toContain(FAILED_TO_RETRIEVE_CONTACT_PUBLIC_KEY_ERROR);
    expect(result).toContain('String error');
  });

  it('should handle null/undefined gracefully', () => {
    const result1 = getPublicKeyErrorMessage(null);
    const result2 = getPublicKeyErrorMessage(undefined);
    expect(result1).toContain(FAILED_TO_RETRIEVE_CONTACT_PUBLIC_KEY_ERROR);
    expect(result2).toContain(FAILED_TO_RETRIEVE_CONTACT_PUBLIC_KEY_ERROR);
  });
});

describe('AuthService', () => {
  let mockAuthProtocol: IAuthProtocol;
  let authService: AuthService;
  let testUserId: string;
  let testUserIdBytes: Uint8Array;
  let testPublicKeys: UserPublicKeys;
  let userKeys: UserKeys | null = null;

  beforeEach(async () => {
    await clearAllTables();
    await ensureWasmInitialized();

    testUserIdBytes = new Uint8Array(32).fill(42);
    testUserId = encodeUserId(testUserIdBytes);

    userKeys = generate_user_keys('test-passphrase-' + Date.now());
    testPublicKeys = userKeys.public_keys();

    mockAuthProtocol = createMockAuthProtocol();
    authService = new AuthService(mockAuthProtocol);
  });

  afterEach(async () => {
    if (testPublicKeys) {
      testPublicKeys.free();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      testPublicKeys = null as any;
    }
    if (userKeys) {
      userKeys.free();
      userKeys = null;
    }
    vi.clearAllMocks();
  });

  describe('fetchPublicKeyByUserId', () => {
    it('should successfully fetch and decode public key', async () => {
      const publicKeyBytes = testPublicKeys.to_bytes();
      const base64PublicKey = encodeToBase64(publicKeyBytes);

      vi.mocked(mockAuthProtocol.fetchPublicKeyByUserId).mockResolvedValue(
        base64PublicKey
      );

      const result = await authService.fetchPublicKeyByUserId(testUserId);

      expect(result).toBeInstanceOf(UserPublicKeys);
      expect(mockAuthProtocol.fetchPublicKeyByUserId).toHaveBeenCalledWith(
        testUserIdBytes
      );
    });

    it('should throw when public key is not found', async () => {
      const error = new Error(PUBLIC_KEY_NOT_FOUND_ERROR);
      vi.mocked(mockAuthProtocol.fetchPublicKeyByUserId).mockRejectedValue(
        error
      );

      await expect(
        authService.fetchPublicKeyByUserId(testUserId)
      ).rejects.toThrow(PUBLIC_KEY_NOT_FOUND_MESSAGE);
    });

    it('should throw when fetch fails', async () => {
      const error = new Error(FAILED_TO_FETCH_ERROR);
      vi.mocked(mockAuthProtocol.fetchPublicKeyByUserId).mockRejectedValue(
        error
      );

      await expect(
        authService.fetchPublicKeyByUserId(testUserId)
      ).rejects.toThrow(FAILED_TO_FETCH_MESSAGE);
    });

    it('should throw for network errors', async () => {
      const error = new Error('Network timeout');
      vi.mocked(mockAuthProtocol.fetchPublicKeyByUserId).mockRejectedValue(
        error
      );

      await expect(
        authService.fetchPublicKeyByUserId(testUserId)
      ).rejects.toThrow('Network timeout');
    });

    it('should decode userId correctly before fetching', async () => {
      const publicKeyBytes = testPublicKeys.to_bytes();
      const base64PublicKey = encodeToBase64(publicKeyBytes);

      vi.mocked(mockAuthProtocol.fetchPublicKeyByUserId).mockResolvedValue(
        base64PublicKey
      );

      await authService.fetchPublicKeyByUserId(testUserId);

      expect(mockAuthProtocol.fetchPublicKeyByUserId).toHaveBeenCalledTimes(1);
      const calledWith = vi.mocked(mockAuthProtocol.fetchPublicKeyByUserId).mock
        .calls[0][0];
      expect(Array.from(calledWith)).toEqual(Array.from(testUserIdBytes));
    });
  });

  describe('publishPublicKey', () => {
    let queries: Queries;

    beforeEach(async () => {
      queries = getTestQueries();
      await queries.userProfiles.insert(
        makeUserProfileRow({ userId: testUserId })
      );
    });

    it('should publish if never published before', async () => {
      vi.mocked(mockAuthProtocol.postPublicKey).mockResolvedValue('hash123');

      await authService.publishPublicKey(testPublicKeys, testUserId, queries);

      expect(mockAuthProtocol.postPublicKey).toHaveBeenCalledTimes(1);
      expect(mockAuthProtocol.postPublicKey).toHaveBeenCalledWith(
        encodeToBase64(testPublicKeys.to_bytes())
      );
    });

    it('coalesces concurrent publication attempts for the same user', async () => {
      await Promise.all([
        authService.publishPublicKey(testPublicKeys, testUserId, queries),
        authService.publishPublicKey(testPublicKeys, testUserId, queries),
      ]);

      expect(mockAuthProtocol.postPublicKey).toHaveBeenCalledOnce();
    });

    it('should update lastPublicKeyPush after publishing', async () => {
      vi.mocked(mockAuthProtocol.postPublicKey).mockResolvedValue('hash123');

      await authService.publishPublicKey(testPublicKeys, testUserId, queries);

      const profile = await queries.userProfiles.getById(testUserId);
      expect(profile?.lastPublicKeyPush).toBeTruthy();
    });

    it('atomically preserves publication during a concurrent stale save', async () => {
      const publicationTime = new Date('2026-08-24T12:00:00.000Z');
      const staleTime = new Date(
        publicationTime.getTime() - 25 * 60 * 60 * 1000
      );
      await queries.userProfiles.updateById(testUserId, {
        lastPublicKeyPush: staleTime,
      });
      const staleRow = await queries.userProfiles.getById(testUserId);
      if (!staleRow) throw new Error('test profile missing');
      const staleProfile = rowToUserProfile(staleRow);
      const originalUpsert = queries.userProfiles.upsert.bind(
        queries.userProfiles
      );
      let releaseUpsert!: () => void;
      const upsertGate = new Promise<void>(resolve => {
        releaseUpsert = resolve;
      });
      const upsert = vi
        .spyOn(queries.userProfiles, 'upsert')
        .mockImplementation(async values => {
          await upsertGate;
          await originalUpsert(values);
        });
      const now = vi
        .spyOn(Date, 'now')
        .mockReturnValue(publicationTime.getTime());

      try {
        const staleSave = new ProfileService(queries).save(staleProfile);
        await vi.waitFor(() => expect(upsert).toHaveBeenCalledOnce());
        await authService.publishPublicKey(testPublicKeys, testUserId, queries);
        releaseUpsert();
        await staleSave;

        const profile = await queries.userProfiles.getById(testUserId);
        expect(profile?.lastPublicKeyPush).toEqual(publicationTime);
      } finally {
        releaseUpsert();
        now.mockRestore();
        upsert.mockRestore();
      }
    });

    it('retries timestamp persistence without repeating a successful post', async () => {
      const publicationTime = new Date('2026-08-24T13:00:00.000Z');
      const originalUpdate =
        queries.userProfiles.updateLastPublicKeyPushMax.bind(
          queries.userProfiles
        );
      const update = vi
        .spyOn(queries.userProfiles, 'updateLastPublicKeyPushMax')
        .mockRejectedValueOnce(new Error('timestamp persistence failed'))
        .mockImplementation(originalUpdate);
      const now = vi
        .spyOn(Date, 'now')
        .mockReturnValue(publicationTime.getTime());

      try {
        await expect(
          authService.publishPublicKey(testPublicKeys, testUserId, queries)
        ).rejects.toThrow('timestamp persistence failed');
        await authService.publishPublicKey(testPublicKeys, testUserId, queries);

        expect(mockAuthProtocol.postPublicKey).toHaveBeenCalledOnce();
        expect(update).toHaveBeenCalledTimes(2);
        const profile = await queries.userProfiles.getById(testUserId);
        expect(profile?.lastPublicKeyPush).toEqual(publicationTime);
      } finally {
        now.mockRestore();
        update.mockRestore();
      }
    });

    it('retains a confirmed timestamp until its profile row exists', async () => {
      const publicationTime = new Date('2026-08-24T14:00:00.000Z');
      const retryTime = new Date('2026-08-24T14:05:00.000Z');
      let currentTime = publicationTime.getTime();
      await queries.userProfiles.delete(testUserId);
      const update = vi.spyOn(
        queries.userProfiles,
        'updateLastPublicKeyPushMax'
      );
      const now = vi.spyOn(Date, 'now').mockImplementation(() => currentTime);

      try {
        await authService.publishPublicKey(testPublicKeys, testUserId, queries);
        expect(mockAuthProtocol.postPublicKey).toHaveBeenCalledOnce();
        await expect(update.mock.results[0].value).resolves.toBe(false);

        await queries.userProfiles.insert(
          makeUserProfileRow({ userId: testUserId })
        );
        currentTime = retryTime.getTime();
        await authService.publishPublicKey(testPublicKeys, testUserId, queries);

        expect(mockAuthProtocol.postPublicKey).toHaveBeenCalledOnce();
        expect(update).toHaveBeenCalledTimes(2);
        const profile = await queries.userProfiles.getById(testUserId);
        expect(profile?.lastPublicKeyPush).toEqual(publicationTime);
      } finally {
        now.mockRestore();
        update.mockRestore();
      }
    });

    it('does not let older pending persistence move durable time backward', async () => {
      const olderTime = new Date('2026-08-24T14:00:00.000Z');
      const newerTime = new Date('2026-08-24T15:00:00.000Z');
      const update = vi
        .spyOn(queries.userProfiles, 'updateLastPublicKeyPushMax')
        .mockRejectedValueOnce(new Error('timestamp persistence failed'));
      const now = vi.spyOn(Date, 'now').mockReturnValue(olderTime.getTime());

      try {
        await expect(
          authService.publishPublicKey(testPublicKeys, testUserId, queries)
        ).rejects.toThrow('timestamp persistence failed');
        await queries.userProfiles.updateById(testUserId, {
          lastPublicKeyPush: newerTime,
        });

        await expect(
          authService.persistPendingPublicationTimestamp(testUserId, queries)
        ).resolves.toBe(true);
        expect(
          (await queries.userProfiles.getById(testUserId))?.lastPublicKeyPush
        ).toEqual(newerTime);
      } finally {
        now.mockRestore();
        update.mockRestore();
      }
    });

    it('retries the post when server success was not confirmed', async () => {
      vi.mocked(mockAuthProtocol.postPublicKey)
        .mockRejectedValueOnce(new Error('network failed'))
        .mockResolvedValueOnce('hash123');

      await expect(
        authService.publishPublicKey(testPublicKeys, testUserId, queries)
      ).rejects.toThrow('network failed');
      await authService.publishPublicKey(testPublicKeys, testUserId, queries);

      expect(mockAuthProtocol.postPublicKey).toHaveBeenCalledTimes(2);
    });

    it('should skip publishing if published less than 24h ago', async () => {
      await queries.userProfiles.updateById(testUserId, {
        lastPublicKeyPush: new Date(),
      });

      await authService.publishPublicKey(testPublicKeys, testUserId, queries);

      expect(mockAuthProtocol.postPublicKey).not.toHaveBeenCalled();
    });

    it('should republish if published more than 24h ago', async () => {
      const over24hAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
      await queries.userProfiles.updateById(testUserId, {
        lastPublicKeyPush: over24hAgo,
      });
      vi.mocked(mockAuthProtocol.postPublicKey).mockResolvedValue('hash123');

      await authService.publishPublicKey(testPublicKeys, testUserId, queries);

      expect(mockAuthProtocol.postPublicKey).toHaveBeenCalledTimes(1);
    });

    it('should propagate error if publishing fails', async () => {
      const publishError = new Error('Publish failed');
      vi.mocked(mockAuthProtocol.postPublicKey).mockRejectedValue(publishError);

      await expect(
        authService.publishPublicKey(testPublicKeys, testUserId, queries)
      ).rejects.toThrow('Publish failed');
    });

    it('should encode public keys to base64 before posting', async () => {
      vi.mocked(mockAuthProtocol.postPublicKey).mockResolvedValue('hash123');

      await authService.publishPublicKey(testPublicKeys, testUserId, queries);

      const calledWith = vi.mocked(mockAuthProtocol.postPublicKey).mock
        .calls[0][0];
      const decoded = decodeFromBase64(calledWith);
      const originalBytes = testPublicKeys.to_bytes();

      expect(Array.from(decoded)).toEqual(Array.from(originalBytes));
    });
  });
});
