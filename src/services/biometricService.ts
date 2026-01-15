import { Capacitor } from '@capacitor/core';
import { SecureStorage } from '@aparajita/capacitor-secure-storage';
import {
  BiometricAuth,
  BiometryError,
  BiometryErrorType,
  BiometryType,
} from '@aparajita/capacitor-biometric-auth';
import {
  isWebAuthnSupported,
  isPlatformAuthenticatorAvailable,
  createWebAuthnCredential,
  authenticateWithWebAuthn,
} from '../crypto/webauthn';
import {
  EncryptionKey,
  encryptionKeyFromBytes,
  generateEncryptionKey,
} from '../../gossip-sdk/src/wasm';
import { encodeToBase64, decodeFromBase64, encodeUserId } from '../utils';

export interface BiometricAvailability {
  available: boolean;
  biometryType?: 'fingerprint' | 'face' | 'none';
  method?: 'capacitor' | 'webauthn' | 'none';
}

export interface BiometricCredentials {
  encryptionKey: EncryptionKey;
}

export interface BiometricCreationData extends BiometricCredentials {
  authMethod: 'capacitor' | 'webauthn';
  credentialId?: string;
}

export interface BiometricResult {
  success: boolean;
  error?: string;
  data?: BiometricCredentials;
}

export interface BiometricCreationResult {
  success: boolean;
  error?: string;
  data?: BiometricCreationData;
}

/**
 * Unified biometric service that uses Capacitor Biometric Auth as default
 * with WebAuthn as fallback for web platforms
 */
export class BiometricService {
  private static instance: BiometricService;
  private isNative: boolean;
  private capacitorAvailable: boolean;
  private isWebAuthnSupported: boolean;

  // Key prefix for secure storage
  private static readonly ENCRYPTION_KEY_PREFIX = 'gossip_encryption_key_';

  private constructor() {
    this.isNative = Capacitor.isNativePlatform();
    this.capacitorAvailable =
      this.isNative && this.checkCapacitorAvailability();
    this.isWebAuthnSupported = isWebAuthnSupported();
  }

  public static getInstance(): BiometricService {
    if (!BiometricService.instance) {
      BiometricService.instance = new BiometricService();
    }
    return BiometricService.instance;
  }

  /**
   * Get user storage key for the encryption key
   */
  private getEncryptionKeyStorageKey(userId: string): string {
    return `${BiometricService.ENCRYPTION_KEY_PREFIX}${userId}`;
  }

  /**
   * Store encryption key securely using Capacitor Secure Storage
   * @param userId - The user ID (Bech32 string)
   * @param encryptionKey - The encryption key to store
   * @param syncToiCloud - Whether to sync to iCloud Keychain (iOS only)
   */
  private async storeEncryptionKey(
    userId: string,
    encryptionKey: EncryptionKey,
    syncToiCloud = false
  ): Promise<void> {
    try {
      const storageKey = this.getEncryptionKeyStorageKey(userId);
      const keyBytes = encryptionKey.to_bytes();
      const keyBase64 = encodeToBase64(keyBytes);

      await SecureStorage.set(storageKey, keyBase64, syncToiCloud);
    } catch (error) {
      console.error('Failed to store encryption key:', error);
      throw new Error(
        `Failed to store encryption key: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Retrieve encryption key from secure storage
   * @param userId - The user ID (Bech32 string)
   * @param syncFromiCloud - Whether to retrieve from iCloud Keychain (iOS only)
   */
  private async retrieveEncryptionKey(
    userId: string,
    syncFromiCloud = false
  ): Promise<EncryptionKey> {
    try {
      const storageKey = this.getEncryptionKeyStorageKey(userId);
      const keyBase64 = await SecureStorage.get(storageKey, syncFromiCloud);

      if (!keyBase64 || typeof keyBase64 !== 'string') {
        throw new Error('Encryption key not found in secure storage');
      }

      const keyBytes = decodeFromBase64(keyBase64);
      return encryptionKeyFromBytes(keyBytes);
    } catch (error) {
      console.error('Failed to retrieve encryption key:', error);
      throw new Error(
        `Failed to retrieve encryption key: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Remove encryption key from secure storage (for account deletion)
   * @param userId - The user ID (Bech32 string)
   * @param syncToiCloud - Whether to also remove from iCloud Keychain (iOS only)
   */
  public async removeEncryptionKey(
    userId: string,
    syncToiCloud = false
  ): Promise<void> {
    try {
      const storageKey = this.getEncryptionKeyStorageKey(userId);
      await SecureStorage.remove(storageKey, syncToiCloud);
    } catch (error) {
      console.error('Failed to remove encryption key:', error);
      // Don't throw error on removal failure
    }
  }

  private checkCapacitorAvailability(): boolean {
    try {
      return (
        typeof BiometricAuth !== 'undefined' &&
        typeof BiometricAuth.checkBiometry === 'function'
      );
    } catch {
      return false;
    }
  }

  /**
   * Internal method that performs all biometric checks once
   * Returns both methods and detailed availability information
   */
  private async performBiometricChecks(): Promise<{
    capacitorAvailable: boolean;
    webauthnAvailable: boolean;
    capacitorBiometryType: BiometryType | undefined;
  }> {
    let capacitorAvailable = false;
    let webauthnAvailable = false;
    let capacitorBiometryType: BiometryType | undefined;
    // Check Capacitor Biometric Auth
    if (this.capacitorAvailable) {
      try {
        const { isAvailable, biometryType } =
          await BiometricAuth.checkBiometry();
        capacitorAvailable = isAvailable;
        capacitorBiometryType = biometryType;
      } catch (error) {
        console.warn('Capacitor biometric not available:', error);
      }
    }

    // Check WebAuthn
    if (this.isWebAuthnSupported) {
      try {
        webauthnAvailable = await isPlatformAuthenticatorAvailable();
      } catch (error) {
        console.warn('WebAuthn not available:', error);
      }
    }

    return { capacitorAvailable, webauthnAvailable, capacitorBiometryType };
  }

  /**
   * Check if biometric authentication is available with detailed information
   * Returns both availability details and which methods are supported
   */
  public async checkAvailability(): Promise<BiometricAvailability> {
    const { capacitorAvailable, webauthnAvailable, capacitorBiometryType } =
      await this.performBiometricChecks();

    // Try Capacitor Biometric Auth first (native)
    if (capacitorAvailable) {
      return {
        available: true,
        biometryType: this.mapBiometryType(capacitorBiometryType!),
        method: 'capacitor' as const,
      };
    }

    // Fallback to WebAuthn
    if (webauthnAvailable) {
      return {
        available: webauthnAvailable,
        biometryType: 'fingerprint',
        method: 'webauthn' as const,
      };
    }

    return {
      available: false,
      biometryType: 'none',
      method: 'none' as const,
    };
  }

  /**
   * Create a new biometric credential
   * @param username - Username for credential creation
   * @param userId - User ID bytes
   * @param salt - Salt for PRF extension (required for WebAuthn)
   * @param syncToiCloud - Whether to sync to iCloud Keychain (iOS only, default: false)
   */
  public async createCredential(
    username: string,
    userId: Uint8Array,
    salt: Uint8Array,
    syncToiCloud = false
  ): Promise<BiometricCreationResult> {
    // For native platforms, create biometric credentials without WebAuthn browser APIs
    if (this.capacitorAvailable) {
      try {
        // Verify biometric authentication first
        await BiometricAuth.authenticate({
          reason: 'Authenticate to complete account setup',
          allowDeviceCredential: true,
        });

        // Generate a new encryption key
        const encryptionKey = await generateEncryptionKey();

        // Store the encryption key securely
        const userIdStr = encodeUserId(userId);
        await this.storeEncryptionKey(userIdStr, encryptionKey, syncToiCloud);

        return {
          success: true,
          data: {
            encryptionKey,
            authMethod: 'capacitor',
          },
        };
      } catch (error) {
        console.error('Native biometric credential creation failed:', error);
        return {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : 'Failed to create biometric credential',
        };
      }
    }

    // Fallback to WebAuthn only for web
    try {
      const webAuthnResult = await createWebAuthnCredential(
        username,
        userId,
        salt
      );
      return {
        success: true,
        data: {
          credentialId: webAuthnResult.credentialId,
          encryptionKey: webAuthnResult.encryptionKey,
          authMethod: 'webauthn',
        },
      };
    } catch (error) {
      console.error('WebAuthn credential creation failed:', error);
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : 'Failed to create biometric credential',
      };
    }
  }

  /**
   * Authenticate using existing biometric credential
   * @param method - The authentication method to use
   * @param userIdOrCredentialId - For Capacitor: the userId (Bech32 string) to retrieve encryption key. For WebAuthn: the credential ID
   * @param salt - The salt used during credential creation (required for WebAuthn PRF)
   * @param syncFromiCloud - Whether to retrieve from iCloud Keychain (iOS only, for Capacitor method)
   */
  public async authenticate(
    method: 'capacitor' | 'webauthn',
    userIdOrCredentialId?: string,
    salt?: Uint8Array,
    syncFromiCloud = false
  ): Promise<BiometricResult> {
    try {
      // Use Capacitor Biometric Auth for native platforms
      if (method === 'capacitor' && this.capacitorAvailable) {
        if (!userIdOrCredentialId) {
          throw new Error('User ID is required for Capacitor authentication');
        }

        // Authenticate with biometrics first
        await BiometricAuth.authenticate({
          reason: 'Authenticate to access your account',
          allowDeviceCredential: true,
        });

        // Retrieve the encryption key from secure storage
        const encryptionKey = await this.retrieveEncryptionKey(
          userIdOrCredentialId,
          syncFromiCloud
        );

        return { success: true, data: { encryptionKey } };
      } else if (method === 'webauthn' && this.isWebAuthnSupported) {
        if (!userIdOrCredentialId || !salt) {
          throw new Error(
            'Credential ID and salt are required for WebAuthn authentication'
          );
        }
        const webAuthnResult = await authenticateWithWebAuthn(
          userIdOrCredentialId,
          salt
        );
        return {
          success: true,
          data: webAuthnResult,
        };
      }
      throw new Error(
        `Invalid or not available authentication method ${method}`
      );
    } catch (error) {
      console.error('Biometric authentication failed:', error);

      // Handle Capacitor biometric errors
      if (
        error instanceof BiometryError &&
        error.code === BiometryErrorType.userCancel
      ) {
        return {
          success: false,
          error: 'Authentication was cancelled',
        };
      }

      // Handle WebAuthn DOMException errors
      if (
        error instanceof Error &&
        (error.name === 'NotAllowedError' ||
          error.message.includes('not allowed'))
      ) {
        return {
          success: false,
          error: 'Authentication was cancelled or timed out',
        };
      }

      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : 'Biometric authentication failed',
      };
    }
  }

  /**
   * Get the current platform and authentication method info
   */
  public getPlatformInfo() {
    return {
      isNative: this.isNative,
      capacitorAvailable: this.capacitorAvailable,
      platform: Capacitor.getPlatform(),
      webAuthnSupported: isWebAuthnSupported(),
    };
  }

  /**
   * Map Capacitor biometry type to our simplified type
   */
  private mapBiometryType(type: BiometryType): 'fingerprint' | 'face' | 'none' {
    switch (type) {
      case BiometryType.touchId:
      case BiometryType.fingerprintAuthentication:
        return 'fingerprint';
      case BiometryType.faceId:
      case BiometryType.faceAuthentication:
        return 'face';
      case BiometryType.none:
      default:
        return 'none';
    }
  }
}

// Export singleton instance
export const biometricService = BiometricService.getInstance();
