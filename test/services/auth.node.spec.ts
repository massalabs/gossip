import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AuthService } from '../../src/services/auth';
import { encodeToBase64 } from '../../src/utils/base64';
import { encodeUserId } from '../../src/utils/userId';
import { IMessageProtocol } from '../../src/api/messageProtocol/types';
import { db } from '../../src/db';
import { userProfile } from '../helpers';
import type { UserPublicKeys } from '../../src/assets/generated/wasm/gossip_wasm';

// Helper to create a mock UserPublicKeys
const createMockPublicKeys = (): UserPublicKeys =>
  ({
    to_bytes: vi.fn(() => new Uint8Array(64).fill(2)),
    free: vi.fn(),
    derive_id: new Uint8Array(32),
    dsa_verification_key: new Uint8Array(32),
    kem_public_key: new Uint8Array(32),
    kdf_public_key: new Uint8Array(32),
    password_kdf_public_key: new Uint8Array(32),
    massa_public_key: new Uint8Array(32),
    [Symbol.dispose]: vi.fn(),
  }) as unknown as UserPublicKeys;

// Mock WASM module
vi.mock('../../src/assets/generated/wasm/gossip_wasm', () => ({
  UserPublicKeys: {
    from_bytes: vi.fn(() => createMockPublicKeys()),
  },
}));

// Mock dependencies
vi.mock('../../src/db', () => ({
  db: {
    userProfile: {
      get: vi.fn(),
      update: vi.fn(),
    },
  },
}));

describe('services/auth.ts - AuthService', () => {
  let authService: AuthService;
  let mockMessageProtocol: IMessageProtocol;
  let mockPublicKeys: UserPublicKeys;
  let testUserId: string;

  beforeEach(async () => {
    // Create mock message protocol
    mockMessageProtocol = {
      fetchPublicKeyByUserId: vi.fn(),
      postPublicKey: vi.fn(),
      fetchMessages: vi.fn(),
      postMessage: vi.fn(),
      fetchAnnouncements: vi.fn(),
      postAnnouncement: vi.fn(),
    } as unknown as IMessageProtocol;

    authService = new AuthService(mockMessageProtocol);

    // Generate test data
    const testUserIdBytes = new Uint8Array(32).fill(1);
    testUserId = encodeUserId(testUserIdBytes);

    // Mock public keys (we'll use a mock since WASM might not be available)
    mockPublicKeys = {
      to_bytes: vi.fn(() => new Uint8Array(64).fill(2)),
    } as unknown as UserPublicKeys;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('fetchPublicKeyByUserId()', () => {
    it('should successfully fetch and decode public key', async () => {
      const mockKeyBytes = new Uint8Array(64).fill(3);
      const mockKeyBase64 = encodeToBase64(mockKeyBytes);

      vi.mocked(mockMessageProtocol.fetchPublicKeyByUserId).mockResolvedValue(
        mockKeyBase64
      );

      const result = await authService.fetchPublicKeyByUserId(testUserId);

      expect(result.success).toBe(true);
      expect(result.publicKey).toBeDefined();
      expect(result.error).toBeUndefined();
      expect(mockMessageProtocol.fetchPublicKeyByUserId).toHaveBeenCalledTimes(
        1
      );
    });

    it('should handle public key not found', async () => {
      vi.mocked(mockMessageProtocol.fetchPublicKeyByUserId).mockResolvedValue(
        null as unknown as string
      );

      const result = await authService.fetchPublicKeyByUserId(testUserId);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Public key not found');
      expect(result.publicKey).toBeUndefined();
    });

    it('should handle network errors', async () => {
      vi.mocked(mockMessageProtocol.fetchPublicKeyByUserId).mockRejectedValue(
        new Error('Network error')
      );

      const result = await authService.fetchPublicKeyByUserId(testUserId);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Network error');
      expect(result.publicKey).toBeUndefined();
    });

    it('should handle non-Error exceptions', async () => {
      vi.mocked(mockMessageProtocol.fetchPublicKeyByUserId).mockRejectedValue(
        'Unknown error'
      );

      const result = await authService.fetchPublicKeyByUserId(testUserId);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Failed to fetch public key');
      expect(result.publicKey).toBeUndefined();
    });

    it('should decode userId before fetching', async () => {
      vi.mocked(mockMessageProtocol.fetchPublicKeyByUserId).mockResolvedValue(
        null as unknown as string
      );

      await authService.fetchPublicKeyByUserId(testUserId);

      // Verify it was called with decoded bytes
      expect(mockMessageProtocol.fetchPublicKeyByUserId).toHaveBeenCalledWith(
        expect.any(Uint8Array)
      );
    });

    it('should handle invalid userId format (invalid Bech32)', async () => {
      const result = await authService.fetchPublicKeyByUserId('invalid-userid');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.publicKey).toBeUndefined();
    });

    it('should handle empty userId', async () => {
      const result = await authService.fetchPublicKeyByUserId('');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.publicKey).toBeUndefined();
    });

    it('should handle invalid base64 in response', async () => {
      vi.mocked(mockMessageProtocol.fetchPublicKeyByUserId).mockResolvedValue(
        'not-valid-base64!!!'
      );

      const result = await authService.fetchPublicKeyByUserId(testUserId);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.publicKey).toBeUndefined();
    });
  });

  describe('ensurePublicKeyPublished()', () => {
    it('should not publish if key was pushed within last week', async () => {
      const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);

      vi.mocked(db.userProfile.get).mockResolvedValue(
        userProfile()
          .userId(testUserId)
          .username('testuser')
          .lastPublicKeyPush(threeDaysAgo)
          .build()
      );

      await authService.ensurePublicKeyPublished(mockPublicKeys, testUserId);

      expect(mockMessageProtocol.postPublicKey).not.toHaveBeenCalled();
      expect(db.userProfile.update).not.toHaveBeenCalled();
    });

    it('should publish if key was never pushed', async () => {
      vi.mocked(db.userProfile.get).mockResolvedValue(
        userProfile().userId(testUserId).username('testuser').build()
      );

      await authService.ensurePublicKeyPublished(mockPublicKeys, testUserId);

      expect(mockMessageProtocol.postPublicKey).toHaveBeenCalledTimes(1);
      expect(mockMessageProtocol.postPublicKey).toHaveBeenCalledWith(
        expect.any(String)
      );
      expect(db.userProfile.update).toHaveBeenCalledWith(testUserId, {
        lastPublicKeyPush: expect.any(Date),
      });
    });

    it('should publish if key was pushed more than a week ago', async () => {
      const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);

      vi.mocked(db.userProfile.get).mockResolvedValue(
        userProfile()
          .userId(testUserId)
          .username('testuser')
          .lastPublicKeyPush(tenDaysAgo)
          .build()
      );

      await authService.ensurePublicKeyPublished(mockPublicKeys, testUserId);

      expect(mockMessageProtocol.postPublicKey).toHaveBeenCalledTimes(1);
      expect(db.userProfile.update).toHaveBeenCalledWith(testUserId, {
        lastPublicKeyPush: expect.any(Date),
      });
    });

    it('should publish if key was pushed exactly one week ago', async () => {
      const exactlyOneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

      vi.mocked(db.userProfile.get).mockResolvedValue(
        userProfile()
          .userId(testUserId)
          .username('testuser')
          .lastPublicKeyPush(exactlyOneWeekAgo)
          .build()
      );

      await authService.ensurePublicKeyPublished(mockPublicKeys, testUserId);

      expect(mockMessageProtocol.postPublicKey).toHaveBeenCalledTimes(1);
    });

    it('should throw error if user profile not found', async () => {
      vi.mocked(db.userProfile.get).mockResolvedValue(undefined);

      await expect(
        authService.ensurePublicKeyPublished(mockPublicKeys, testUserId)
      ).rejects.toThrow('User profile not found');

      expect(mockMessageProtocol.postPublicKey).not.toHaveBeenCalled();
    });

    it('should encode public key to base64 before posting', async () => {
      vi.mocked(db.userProfile.get).mockResolvedValue(
        userProfile().userId(testUserId).username('testuser').build()
      );

      await authService.ensurePublicKeyPublished(mockPublicKeys, testUserId);

      // Verify the posted key is base64 encoded
      expect(mockMessageProtocol.postPublicKey).toHaveBeenCalledWith(
        expect.stringMatching(/^[A-Za-z0-9+/=]+$/)
      );
    });

    it('should update lastPublicKeyPush timestamp after successful publish', async () => {
      const beforePublish = Date.now();

      vi.mocked(db.userProfile.get).mockResolvedValue(
        userProfile().userId(testUserId).username('testuser').build()
      );

      await authService.ensurePublicKeyPublished(mockPublicKeys, testUserId);

      const afterPublish = Date.now();

      expect(db.userProfile.update).toHaveBeenCalledWith(testUserId, {
        lastPublicKeyPush: expect.any(Date),
      });

      // Verify the timestamp is recent
      const updateCall = vi.mocked(db.userProfile.update).mock.calls[0];
      const updateArg = updateCall[1] as { lastPublicKeyPush?: Date };
      const timestamp = updateArg.lastPublicKeyPush as Date;
      expect(timestamp.getTime()).toBeGreaterThanOrEqual(beforePublish);
      expect(timestamp.getTime()).toBeLessThanOrEqual(afterPublish);
    });

    it('should not publish if key was pushed 1 week minus 1ms ago', async () => {
      // Boundary case: just under 1 week - should NOT publish
      const oneWeekMinus1ms = new Date(
        Date.now() - (7 * 24 * 60 * 60 * 1000 - 1)
      );

      vi.mocked(db.userProfile.get).mockResolvedValue(
        userProfile()
          .userId(testUserId)
          .username('testuser')
          .lastPublicKeyPush(oneWeekMinus1ms)
          .build()
      );

      await authService.ensurePublicKeyPublished(mockPublicKeys, testUserId);

      expect(mockMessageProtocol.postPublicKey).not.toHaveBeenCalled();
      expect(db.userProfile.update).not.toHaveBeenCalled();
    });

    it('should propagate error if postPublicKey fails', async () => {
      vi.mocked(db.userProfile.get).mockResolvedValue(
        userProfile().userId(testUserId).username('testuser').build()
      );

      vi.mocked(mockMessageProtocol.postPublicKey).mockRejectedValue(
        new Error('Network timeout')
      );

      await expect(
        authService.ensurePublicKeyPublished(mockPublicKeys, testUserId)
      ).rejects.toThrow('Network timeout');

      // Verify update was not called if publish failed
      expect(db.userProfile.update).not.toHaveBeenCalled();
    });

    it('should propagate error if database update fails', async () => {
      vi.mocked(db.userProfile.get).mockResolvedValue(
        userProfile().userId(testUserId).username('testuser').build()
      );

      vi.mocked(mockMessageProtocol.postPublicKey).mockResolvedValue(
        '' as unknown as string
      );
      vi.mocked(db.userProfile.update).mockRejectedValue(
        new Error('Database write failed')
      );

      await expect(
        authService.ensurePublicKeyPublished(mockPublicKeys, testUserId)
      ).rejects.toThrow('Database write failed');
    });

    it('should propagate error if database get fails', async () => {
      vi.mocked(db.userProfile.get).mockRejectedValue(
        new Error('Database connection lost')
      );

      await expect(
        authService.ensurePublicKeyPublished(mockPublicKeys, testUserId)
      ).rejects.toThrow('Database connection lost');
    });
  });
});
