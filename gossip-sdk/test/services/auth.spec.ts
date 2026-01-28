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
import { db, UserProfile } from '../../src/db';
import type { IMessageProtocol } from '../../src/api/messageProtocol/types';
import {
  UserPublicKeys,
  UserKeys,
  generate_user_keys,
} from '../../src/assets/generated/wasm/gossip_wasm';
import { encodeUserId } from '../../src/utils/userId';
import { encodeToBase64, decodeFromBase64 } from '../../src/utils/base64';
import { ensureWasmInitialized } from '../../src/wasm';

function createMockProtocol(
  overrides: Partial<IMessageProtocol> = {}
): IMessageProtocol {
  return {
    fetchMessages: vi.fn().mockResolvedValue([]),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendAnnouncement: vi.fn().mockResolvedValue('1'),
    fetchAnnouncements: vi.fn().mockResolvedValue([]),
    fetchPublicKeyByUserId: vi.fn().mockResolvedValue(''),
    postPublicKey: vi.fn().mockResolvedValue('hash'),
    changeNode: vi.fn().mockResolvedValue({ success: true }),
    ...overrides,
  };
}

function createUserProfile(
  userId: string,
  overrides: Partial<UserProfile> = {}
): UserProfile {
  return {
    userId,
    username: 'testuser',
    security: {
      encKeySalt: new Uint8Array(32),
      authMethod: 'password' as const,
      mnemonicBackup: {
        encryptedMnemonic: new Uint8Array(64),
        createdAt: new Date(),
        backedUp: false,
      },
    },
    session: new Uint8Array(32),
    status: 'online' as const,
    lastSeen: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
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
  let mockMessageProtocol: IMessageProtocol;
  let authService: AuthService;
  let testUserId: string;
  let testUserIdBytes: Uint8Array;
  let testPublicKeys: UserPublicKeys;
  let userKeys: UserKeys | null = null;

  beforeEach(async () => {
    await ensureWasmInitialized();

    if (!db.isOpen()) {
      await db.open();
    }
    await Promise.all(db.tables.map(table => table.clear()));

    testUserIdBytes = new Uint8Array(32).fill(42);
    testUserId = encodeUserId(testUserIdBytes);

    userKeys = generate_user_keys('test-passphrase-' + Date.now());
    testPublicKeys = userKeys.public_keys();

    mockMessageProtocol = createMockProtocol();
    authService = new AuthService(db, mockMessageProtocol);
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

      vi.mocked(mockMessageProtocol.fetchPublicKeyByUserId).mockResolvedValue(
        base64PublicKey
      );

      const result = await authService.fetchPublicKeyByUserId(testUserId);

      expect(result).toHaveProperty('publicKey');
      expect(result).not.toHaveProperty('error');
      expect(result.publicKey).toBeInstanceOf(UserPublicKeys);
      expect(mockMessageProtocol.fetchPublicKeyByUserId).toHaveBeenCalledWith(
        testUserIdBytes
      );
    });

    it('should return error when public key is not found', async () => {
      const error = new Error(PUBLIC_KEY_NOT_FOUND_ERROR);
      vi.mocked(mockMessageProtocol.fetchPublicKeyByUserId).mockRejectedValue(
        error
      );

      const result = await authService.fetchPublicKeyByUserId(testUserId);

      expect(result).toHaveProperty('error');
      expect(result).not.toHaveProperty('publicKey');
      expect(result.error).toBe(PUBLIC_KEY_NOT_FOUND_MESSAGE);
    });

    it('should return error when fetch fails', async () => {
      const error = new Error(FAILED_TO_FETCH_ERROR);
      vi.mocked(mockMessageProtocol.fetchPublicKeyByUserId).mockRejectedValue(
        error
      );

      const result = await authService.fetchPublicKeyByUserId(testUserId);

      expect(result).toHaveProperty('error');
      expect(result.error).toBe(FAILED_TO_FETCH_MESSAGE);
    });

    it('should return error for network errors', async () => {
      const error = new Error('Network timeout');
      vi.mocked(mockMessageProtocol.fetchPublicKeyByUserId).mockRejectedValue(
        error
      );

      const result = await authService.fetchPublicKeyByUserId(testUserId);

      expect(result).toHaveProperty('error');
      expect(result.error).toContain(
        FAILED_TO_RETRIEVE_CONTACT_PUBLIC_KEY_ERROR
      );
      expect(result.error).toContain('Network timeout');
    });

    it('should decode userId correctly before fetching', async () => {
      const publicKeyBytes = testPublicKeys.to_bytes();
      const base64PublicKey = encodeToBase64(publicKeyBytes);

      vi.mocked(mockMessageProtocol.fetchPublicKeyByUserId).mockResolvedValue(
        base64PublicKey
      );

      await authService.fetchPublicKeyByUserId(testUserId);

      expect(mockMessageProtocol.fetchPublicKeyByUserId).toHaveBeenCalledTimes(
        1
      );
      const calledWith = vi.mocked(mockMessageProtocol.fetchPublicKeyByUserId)
        .mock.calls[0][0];
      expect(Array.from(calledWith)).toEqual(Array.from(testUserIdBytes));
    });
  });

  describe('ensurePublicKeyPublished', () => {
    it('should not publish if last push was less than one week ago', async () => {
      const profile = createUserProfile(testUserId, {
        lastPublicKeyPush: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
      });

      await db.userProfile.add(profile);

      await authService.ensurePublicKeyPublished(testPublicKeys, testUserId);

      expect(mockMessageProtocol.postPublicKey).not.toHaveBeenCalled();
    });

    it('should publish if last push was more than one week ago', async () => {
      const profile = createUserProfile(testUserId, {
        lastPublicKeyPush: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
      });

      await db.userProfile.add(profile);

      vi.mocked(mockMessageProtocol.postPublicKey).mockResolvedValue('hash123');

      await authService.ensurePublicKeyPublished(testPublicKeys, testUserId);

      expect(mockMessageProtocol.postPublicKey).toHaveBeenCalledTimes(1);
      const calledWith = vi.mocked(mockMessageProtocol.postPublicKey).mock
        .calls[0][0];
      expect(calledWith).toBe(encodeToBase64(testPublicKeys.to_bytes()));

      const updatedProfile = await db.userProfile.get(testUserId);
      expect(updatedProfile?.lastPublicKeyPush).toBeDefined();
      expect(updatedProfile?.lastPublicKeyPush?.getTime()).toBeGreaterThan(
        profile.lastPublicKeyPush!.getTime()
      );
    });

    it('should publish if lastPublicKeyPush is undefined', async () => {
      const profile = createUserProfile(testUserId);

      await db.userProfile.add(profile);

      vi.mocked(mockMessageProtocol.postPublicKey).mockResolvedValue('hash123');

      await authService.ensurePublicKeyPublished(testPublicKeys, testUserId);

      expect(mockMessageProtocol.postPublicKey).toHaveBeenCalledTimes(1);

      const updatedProfile = await db.userProfile.get(testUserId);
      expect(updatedProfile?.lastPublicKeyPush).toBeDefined();
    });

    it('should publish if last push was exactly one week ago', async () => {
      const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const profile = createUserProfile(testUserId, {
        lastPublicKeyPush: oneWeekAgo,
      });

      await db.userProfile.add(profile);

      vi.mocked(mockMessageProtocol.postPublicKey).mockResolvedValue('hash123');

      await authService.ensurePublicKeyPublished(testPublicKeys, testUserId);

      expect(mockMessageProtocol.postPublicKey).toHaveBeenCalledTimes(1);
    });

    it('should throw error if user profile not found', async () => {
      await expect(
        authService.ensurePublicKeyPublished(testPublicKeys, testUserId)
      ).rejects.toThrow('User profile not found');

      expect(mockMessageProtocol.postPublicKey).not.toHaveBeenCalled();
    });

    it('should encode public keys to base64 before posting', async () => {
      const profile = createUserProfile(testUserId, {
        lastPublicKeyPush: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
      });

      await db.userProfile.add(profile);

      vi.mocked(mockMessageProtocol.postPublicKey).mockResolvedValue('hash123');

      await authService.ensurePublicKeyPublished(testPublicKeys, testUserId);

      const calledWith = vi.mocked(mockMessageProtocol.postPublicKey).mock
        .calls[0][0];
      const decoded = decodeFromBase64(calledWith);
      const originalBytes = testPublicKeys.to_bytes();

      expect(Array.from(decoded)).toEqual(Array.from(originalBytes));
    });
  });
});
