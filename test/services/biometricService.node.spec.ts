import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  BiometricCreationData,
  BiometricCredentials,
  BiometricService,
} from '../../src/services/biometricService';

// Mock all external dependencies
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: vi.fn(() => false),
    getPlatform: vi.fn(() => 'web'),
  },
}));

vi.mock('@aparajita/capacitor-secure-storage', () => ({
  SecureStorage: {
    set: vi.fn(),
    get: vi.fn(),
    remove: vi.fn(),
  },
}));

vi.mock('@aparajita/capacitor-biometric-auth', () => ({
  BiometricAuth: {
    checkBiometry: vi.fn(),
    authenticate: vi.fn(),
  },
  BiometryType: {
    none: 0,
    touchId: 1,
    faceId: 2,
    fingerprintAuthentication: 3,
    faceAuthentication: 4,
  },
  BiometryError: class BiometryError extends Error {
    code: number;
    constructor(message: string, code: number) {
      super(message);
      this.code = code;
    }
  },
  BiometryErrorType: {
    userCancel: 10,
  },
}));

vi.mock('../../src/crypto/webauthn', () => ({
  isWebAuthnSupported: vi.fn(() => false),
  isPlatformAuthenticatorAvailable: vi.fn(() => Promise.resolve(false)),
  createWebAuthnCredential: vi.fn(),
  authenticateWithWebAuthn: vi.fn(),
}));

vi.mock('../../src/wasm', () => ({
  generateEncryptionKey: vi.fn(() =>
    Promise.resolve({
      to_bytes: () => new Uint8Array(32).fill(1),
    })
  ),
  encryptionKeyFromBytes: vi.fn((bytes: Uint8Array) => ({
    to_bytes: () => bytes,
  })),
}));

describe('services/biometricService.ts - BiometricService', () => {
  let biometricService: BiometricService;

  beforeEach(() => {
    // Reset singleton between tests
    (BiometricService as unknown as { instance: undefined }).instance =
      undefined;
    biometricService = BiometricService.getInstance();
    vi.clearAllMocks();
  });

  describe('getInstance()', () => {
    it('should return singleton instance', () => {
      const instance1 = BiometricService.getInstance();
      const instance2 = BiometricService.getInstance();

      expect(instance1).toBe(instance2);
      expect(instance1).toBeInstanceOf(BiometricService);
    });

    it('should initialize with web platform by default', () => {
      const platformInfo = biometricService.getPlatformInfo();

      expect(platformInfo.isNative).toBe(false);
      expect(platformInfo.platform).toBe('web');
      expect(platformInfo.capacitorAvailable).toBe(false);
    });
  });

  describe('getPlatformInfo()', () => {
    it('should return complete platform information', () => {
      const info = biometricService.getPlatformInfo();

      expect(info).toHaveProperty('isNative');
      expect(info).toHaveProperty('capacitorAvailable');
      expect(info).toHaveProperty('platform');
      expect(info).toHaveProperty('webAuthnSupported');
    });

    it('should indicate web platform when not native', () => {
      const info = biometricService.getPlatformInfo();

      expect(info.isNative).toBe(false);
      expect(info.platform).toBe('web');
      expect(info.capacitorAvailable).toBe(false);
    });
  });

  describe('checkAvailability()', () => {
    it('should return unavailable when no biometric methods available', async () => {
      const result = await biometricService.checkAvailability();

      expect(result.available).toBe(false);
      expect(result.biometryType).toBe('none');
      expect(result.method).toBe('none');
    });

    it('should return WebAuthn availability when supported', async () => {
      const { isWebAuthnSupported, isPlatformAuthenticatorAvailable } =
        await import('../../src/crypto/webauthn');

      vi.mocked(isWebAuthnSupported).mockReturnValue(true);
      vi.mocked(isPlatformAuthenticatorAvailable).mockResolvedValue(true);

      // Create new instance to pick up mocked values
      (BiometricService as unknown as { instance: undefined }).instance =
        undefined;
      const service = BiometricService.getInstance();

      const result = await service.checkAvailability();

      expect(result.available).toBe(true);
      expect(result.biometryType).toBe('fingerprint');
      expect(result.method).toBe('webauthn');
    });

    it('should handle errors gracefully', async () => {
      const { isPlatformAuthenticatorAvailable } = await import(
        '../../src/crypto/webauthn'
      );

      vi.mocked(isPlatformAuthenticatorAvailable).mockRejectedValue(
        new Error('Platform check failed')
      );

      const result = await biometricService.checkAvailability();

      expect(result.available).toBe(false);
      expect(result.method).toBe('none');
    });
  });

  describe('createCredential() - WebAuthn fallback', () => {
    it('should create WebAuthn credential when Capacitor unavailable', async () => {
      const { createWebAuthnCredential } = await import(
        '../../src/crypto/webauthn'
      );

      const mockCredential = {
        credentialId: 'test-cred-id',
        encryptionKey: {
          to_bytes: () => new Uint8Array(32).fill(2),
        },
      };

      vi.mocked(createWebAuthnCredential).mockResolvedValue(
        mockCredential as unknown as BiometricCreationData
      );

      const result = await biometricService.createCredential(
        'testuser',
        new Uint8Array(32).fill(1),
        new Uint8Array(32).fill(3)
      );

      expect(result.success).toBe(true);
      expect(result.data?.authMethod).toBe('webauthn');
      expect(result.data?.credentialId).toBe('test-cred-id');
      expect(result.data?.encryptionKey).toBeDefined();
    });

    it('should handle WebAuthn creation failure', async () => {
      const { createWebAuthnCredential } = await import(
        '../../src/crypto/webauthn'
      );

      vi.mocked(createWebAuthnCredential).mockRejectedValue(
        new Error('User cancelled')
      );

      const result = await biometricService.createCredential(
        'testuser',
        new Uint8Array(32).fill(1),
        new Uint8Array(32).fill(3)
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('User cancelled');
    });

    it('should handle non-Error exceptions in creation', async () => {
      const { createWebAuthnCredential } = await import(
        '../../src/crypto/webauthn'
      );

      vi.mocked(createWebAuthnCredential).mockRejectedValue('Unknown error');

      const result = await biometricService.createCredential(
        'testuser',
        new Uint8Array(32).fill(1),
        new Uint8Array(32).fill(3)
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Failed to create biometric credential');
    });
  });

  describe('authenticate() - WebAuthn', () => {
    it('should authenticate with WebAuthn when supported', async () => {
      const { isWebAuthnSupported, authenticateWithWebAuthn } = await import(
        '../../src/crypto/webauthn'
      );

      vi.mocked(isWebAuthnSupported).mockReturnValue(true);

      // Recreate instance with WebAuthn support
      (BiometricService as unknown as { instance: undefined }).instance =
        undefined;
      const service = BiometricService.getInstance();

      const mockCredentials = {
        encryptionKey: {
          to_bytes: () => new Uint8Array(32).fill(4),
        },
      };

      vi.mocked(authenticateWithWebAuthn).mockResolvedValue(
        mockCredentials as unknown as BiometricCredentials
      );

      const result = await service.authenticate(
        'webauthn',
        'test-cred-id',
        new Uint8Array(32).fill(3)
      );

      expect(result.success).toBe(true);
      expect(result.data?.encryptionKey).toBeDefined();
      expect(authenticateWithWebAuthn).toHaveBeenCalledWith(
        'test-cred-id',
        expect.any(Uint8Array)
      );
    });

    it('should require credentialId and salt for WebAuthn', async () => {
      const { isWebAuthnSupported } = await import('../../src/crypto/webauthn');

      vi.mocked(isWebAuthnSupported).mockReturnValue(true);

      (BiometricService as unknown as { instance: undefined }).instance =
        undefined;
      const service = BiometricService.getInstance();

      const result = await service.authenticate('webauthn');

      expect(result.success).toBe(false);
      expect(result.error).toContain(
        'Credential ID and salt are required for WebAuthn'
      );
    });

    it('should handle authentication cancellation', async () => {
      const { isWebAuthnSupported, authenticateWithWebAuthn } = await import(
        '../../src/crypto/webauthn'
      );

      vi.mocked(isWebAuthnSupported).mockReturnValue(true);

      (BiometricService as unknown as { instance: undefined }).instance =
        undefined;
      const service = BiometricService.getInstance();

      const notAllowedError = new Error('User cancelled');
      notAllowedError.name = 'NotAllowedError';

      vi.mocked(authenticateWithWebAuthn).mockRejectedValue(notAllowedError);

      const result = await service.authenticate(
        'webauthn',
        'test-cred-id',
        new Uint8Array(32)
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Authentication was cancelled or timed out');
    });

    it('should reject invalid authentication method', async () => {
      const result = await biometricService.authenticate(
        'capacitor' as 'capacitor' | 'webauthn',
        'test-id'
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid or not available');
    });
  });

  describe('removeEncryptionKey()', () => {
    it('should remove encryption key from storage', async () => {
      const { SecureStorage } = await import(
        '@aparajita/capacitor-secure-storage'
      );

      await biometricService.removeEncryptionKey('gossip1test123');

      expect(SecureStorage.remove).toHaveBeenCalledWith(
        'gossip_encryption_key_gossip1test123',
        false
      );
    });

    it('should handle iCloud sync parameter', async () => {
      const { SecureStorage } = await import(
        '@aparajita/capacitor-secure-storage'
      );

      await biometricService.removeEncryptionKey('gossip1test123', true);

      expect(SecureStorage.remove).toHaveBeenCalledWith(
        'gossip_encryption_key_gossip1test123',
        true
      );
    });

    it('should not throw error if removal fails', async () => {
      const { SecureStorage } = await import(
        '@aparajita/capacitor-secure-storage'
      );

      vi.mocked(SecureStorage.remove).mockRejectedValue(
        new Error('Key not found')
      );

      await expect(
        biometricService.removeEncryptionKey('gossip1test123')
      ).resolves.not.toThrow();
    });
  });
});
