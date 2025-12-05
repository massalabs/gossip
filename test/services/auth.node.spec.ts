/**
 * Auth Service Tests
 *
 * Tests for the AuthService class and related utilities.
 */

// Import test setup first to initialize fake-indexeddb
import '../setup';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  AuthService,
  getPublicKeyErrorMessage,
  PUBLIC_KEY_NOT_FOUND_ERROR,
  PUBLIC_KEY_NOT_FOUND_MESSAGE,
  FAILED_TO_FETCH_ERROR,
  FAILED_TO_FETCH_MESSAGE,
  FAILED_TO_RETRIEVE_CONTACT_PUBLIC_KEY_ERROR,
} from '../../src/services/auth';
import { IMessageProtocol } from '../../src/api/messageProtocol/types';
import { encodeUserId } from '../../src/utils/userId';
import { encodeToBase64, decodeFromBase64 } from '../../src/utils/base64';
import { db } from '../../src/db';
import { userProfile } from '../helpers/factories/userProfile';
import { UserPublicKeys } from '../../src/assets/generated/wasm/gossip_wasm';

// Mock the WASM module using helper
// Use vi.hoisted to import the helper before the mock is hoisted
const { getMockUserPublicKeys } = await vi.hoisted(async () => {
  return await import('../helpers/mock/wasm');
});

vi.mock('../../src/assets/generated/wasm/gossip_wasm', () => ({
  UserPublicKeys: getMockUserPublicKeys(),
}));

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
  let mockPublicKeys: UserPublicKeys;

  beforeEach(async () => {
    // Create test userId
    testUserIdBytes = new Uint8Array(32).fill(42);
    testUserId = encodeUserId(testUserIdBytes);

    // Create mock public keys using the mocked UserPublicKeys
    const keyBytes = new Uint8Array(96);
    crypto.getRandomValues(keyBytes);
    mockPublicKeys = UserPublicKeys.from_bytes(keyBytes);

    // Create mock message protocol
    mockMessageProtocol = {
      fetchMessages: vi.fn(),
      sendMessage: vi.fn(),
      sendAnnouncement: vi.fn(),
      fetchAnnouncements: vi.fn(),
      fetchPublicKeyByUserId: vi.fn(),
      postPublicKey: vi.fn(),
    };

    authService = new AuthService(mockMessageProtocol);

    // Clear database before each test
    await db.userProfile.clear();
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await db.userProfile.clear();
  });

  describe('fetchPublicKeyByUserId', () => {
    it('should successfully fetch and decode public key', async () => {
      const publicKeyBytes = mockPublicKeys.to_bytes();
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
      const publicKeyBytes = mockPublicKeys.to_bytes();
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
      const profile = userProfile()
        .userId(testUserId)
        .lastPublicKeyPush(new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)) // 3 days ago
        .build();

      await db.userProfile.add(profile);

      await authService.ensurePublicKeyPublished(mockPublicKeys, testUserId);

      expect(mockMessageProtocol.postPublicKey).not.toHaveBeenCalled();
    });

    it('should publish if last push was more than one week ago', async () => {
      const profile = userProfile()
        .userId(testUserId)
        .lastPublicKeyPush(new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)) // 8 days ago
        .build();

      await db.userProfile.add(profile);

      vi.mocked(mockMessageProtocol.postPublicKey).mockResolvedValue('hash123');

      await authService.ensurePublicKeyPublished(mockPublicKeys, testUserId);

      expect(mockMessageProtocol.postPublicKey).toHaveBeenCalledTimes(1);
      const calledWith = vi.mocked(mockMessageProtocol.postPublicKey).mock
        .calls[0][0];
      expect(calledWith).toBe(encodeToBase64(mockPublicKeys.to_bytes()));

      // Verify lastPublicKeyPush was updated
      const updatedProfile = await db.userProfile.get(testUserId);
      expect(updatedProfile?.lastPublicKeyPush).toBeDefined();
      expect(updatedProfile?.lastPublicKeyPush?.getTime()).toBeGreaterThan(
        profile.lastPublicKeyPush!.getTime()
      );
    });

    it('should publish if lastPublicKeyPush is undefined', async () => {
      const profile = userProfile().userId(testUserId).build();
      // lastPublicKeyPush is undefined by default

      await db.userProfile.add(profile);

      vi.mocked(mockMessageProtocol.postPublicKey).mockResolvedValue('hash123');

      await authService.ensurePublicKeyPublished(mockPublicKeys, testUserId);

      expect(mockMessageProtocol.postPublicKey).toHaveBeenCalledTimes(1);
      const calledWith = vi.mocked(mockMessageProtocol.postPublicKey).mock
        .calls[0][0];
      expect(calledWith).toBe(encodeToBase64(mockPublicKeys.to_bytes()));

      // Verify lastPublicKeyPush was set
      const updatedProfile = await db.userProfile.get(testUserId);
      expect(updatedProfile?.lastPublicKeyPush).toBeDefined();
    });

    it('should publish if last push was exactly one week ago', async () => {
      const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const profile = userProfile()
        .userId(testUserId)
        .lastPublicKeyPush(oneWeekAgo)
        .build();

      await db.userProfile.add(profile);

      vi.mocked(mockMessageProtocol.postPublicKey).mockResolvedValue('hash123');

      await authService.ensurePublicKeyPublished(mockPublicKeys, testUserId);

      // Exactly one week should trigger a push
      expect(mockMessageProtocol.postPublicKey).toHaveBeenCalledTimes(1);
    });

    it('should throw error if user profile not found', async () => {
      // Don't add profile to database

      await expect(
        authService.ensurePublicKeyPublished(mockPublicKeys, testUserId)
      ).rejects.toThrow('User profile not found');

      expect(mockMessageProtocol.postPublicKey).not.toHaveBeenCalled();
    });

    it('should encode public keys to base64 before posting', async () => {
      const profile = userProfile()
        .userId(testUserId)
        .lastPublicKeyPush(new Date(Date.now() - 8 * 24 * 60 * 60 * 1000))
        .build();

      await db.userProfile.add(profile);

      vi.mocked(mockMessageProtocol.postPublicKey).mockResolvedValue('hash123');

      await authService.ensurePublicKeyPublished(mockPublicKeys, testUserId);

      const calledWith = vi.mocked(mockMessageProtocol.postPublicKey).mock
        .calls[0][0];
      const decoded = decodeFromBase64(calledWith);
      const originalBytes = mockPublicKeys.to_bytes();

      expect(Array.from(decoded)).toEqual(Array.from(originalBytes));
    });
  });
});
