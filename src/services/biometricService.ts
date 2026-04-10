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
  isWebAuthnPrfSupported,
  createWebAuthnCredential,
  authenticateWithWebAuthn,
} from '../crypto/webauthn';
import {
  EncryptionKey,
  encryptionKeyFromBytes,
  generateEncryptionKey,
  encodeUserId,
} from '@massalabs/gossip-sdk';
import { encodeToBase64, decodeFromBase64 } from '@massalabs/gossip-sdk';
import {
  BIOMETRIC_STORAGE_KEY,
  WEBAUTHN_CREDENTIAL_ID_KEY,
  getBiometricSalt,
} from '../constants/biometric';

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

const ENCRYPTION_KEY_PREFIX = 'gossip_encryption_key_';

const isNative = Capacitor.isNativePlatform();

function isCapacitorAvailable(): boolean {
  return (
    isNative &&
    typeof BiometricAuth !== 'undefined' &&
    typeof BiometricAuth.checkBiometry === 'function'
  );
}

const biometryTypeMap: Partial<Record<BiometryType, 'fingerprint' | 'face'>> = {
  [BiometryType.touchId]: 'fingerprint',
  [BiometryType.fingerprintAuthentication]: 'fingerprint',
  [BiometryType.faceId]: 'face',
  [BiometryType.faceAuthentication]: 'face',
};

function storageKey(userId: string): string {
  return `${ENCRYPTION_KEY_PREFIX}${userId}`;
}

async function storeEncryptionKey(
  userId: string,
  encryptionKey: EncryptionKey,
  syncToiCloud = false
): Promise<void> {
  const keyBytes = encryptionKey.to_bytes();
  const keyBase64 = encodeToBase64(keyBytes);
  keyBytes.fill(0);
  await SecureStorage.set(storageKey(userId), keyBase64, syncToiCloud);
}

async function retrieveEncryptionKey(
  userId: string,
  syncFromiCloud = false
): Promise<EncryptionKey> {
  const keyBase64 = await SecureStorage.get(storageKey(userId), syncFromiCloud);
  if (!keyBase64 || typeof keyBase64 !== 'string') {
    throw new Error('Encryption key not found in secure storage');
  }
  const keyBytes = decodeFromBase64(keyBase64);
  const key = await encryptionKeyFromBytes(keyBytes);
  keyBytes.fill(0);
  return key;
}

export async function hasExistingCredential(
  nativeStorageKey: string
): Promise<boolean> {
  if (isCapacitorAvailable()) {
    try {
      const value = await SecureStorage.get(nativeStorageKey);
      return value != null && value !== '';
    } catch {
      return false;
    }
  }

  // On web, credentials are WebAuthn passkeys; the credential ID is stored
  // in localStorage under a fixed key (not the native storage key).
  if (isWebAuthnSupported()) {
    return localStorage.getItem(WEBAUTHN_CREDENTIAL_ID_KEY) !== null;
  }

  return false;
}

export async function removeEncryptionKey(
  userId: string,
  syncToiCloud = false
): Promise<void> {
  try {
    await SecureStorage.remove(storageKey(userId), syncToiCloud);
  } catch (error) {
    console.error('Failed to remove encryption key:', error);
  }
}

export async function checkBiometricAvailability(): Promise<BiometricAvailability> {
  if (isCapacitorAvailable()) {
    try {
      const { isAvailable, biometryType } = await BiometricAuth.checkBiometry();
      if (isAvailable) {
        return {
          available: true,
          biometryType: biometryTypeMap[biometryType] ?? 'none',
          method: 'capacitor',
        };
      }
    } catch (error) {
      console.warn('Capacitor biometric not available:', error);
    }
  }

  if (isWebAuthnSupported()) {
    try {
      const [platformAvailable, prfSupported] = await Promise.all([
        isPlatformAuthenticatorAvailable(),
        isWebAuthnPrfSupported(),
      ]);
      if (platformAvailable && prfSupported) {
        return {
          available: true,
          biometryType: 'fingerprint',
          method: 'webauthn',
        };
      }
      console.info(
        '[biometric][availability] WebAuthn unavailable after preflight',
        {
          platformAvailable,
          prfSupported,
        }
      );
    } catch (error) {
      console.warn('WebAuthn not available:', error);
    }
  }

  return { available: false, biometryType: 'none', method: 'none' };
}

export async function createCredential(
  username: string,
  userId: Uint8Array,
  salt: Uint8Array,
  syncToiCloud = false
): Promise<BiometricCreationResult> {
  try {
    if (isCapacitorAvailable()) {
      await BiometricAuth.authenticate({
        reason: 'Authenticate to complete account setup',
        allowDeviceCredential: true,
      });

      const encryptionKey = await generateEncryptionKey();
      const userIdStr = encodeUserId(userId);
      await storeEncryptionKey(userIdStr, encryptionKey, syncToiCloud);
      // Also store under the fixed biometric key for SecureLogin discovery
      const keyBytes = encryptionKey.to_bytes();
      const keyBase64 = encodeToBase64(keyBytes);
      keyBytes.fill(0);
      await SecureStorage.set(BIOMETRIC_STORAGE_KEY, keyBase64, syncToiCloud);

      return {
        success: true,
        data: { encryptionKey, authMethod: 'capacitor' },
      };
    }

    const result = await createWebAuthnCredential(username, userId, salt);
    return {
      success: true,
      data: {
        credentialId: result.credentialId,
        encryptionKey: result.encryptionKey,
        authMethod: 'webauthn',
      },
    };
  } catch (error) {
    console.error('Biometric credential creation failed:', error);
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : 'Failed to create biometric credential',
    };
  }
}

function classifyError(error: unknown): string {
  if (error instanceof BiometryError) {
    if (
      error.code === BiometryErrorType.userCancel ||
      error.code === BiometryErrorType.systemCancel ||
      error.code === BiometryErrorType.appCancel ||
      error.code === BiometryErrorType.userFallback
    ) {
      return 'cancelled';
    }
    if (error.code === BiometryErrorType.biometryLockout) {
      return 'biometric_locked';
    }
  }
  if (
    error instanceof Error &&
    (error.name === 'NotAllowedError' || error.message.includes('not allowed'))
  ) {
    return 'cancelled';
  }
  return error instanceof Error
    ? error.message
    : 'Biometric authentication failed';
}

export async function authenticate(
  method: 'capacitor' | 'webauthn',
  userIdOrCredentialId?: string,
  salt?: Uint8Array,
  syncFromiCloud = false
): Promise<BiometricResult> {
  try {
    if (method === 'capacitor' && isCapacitorAvailable()) {
      if (!userIdOrCredentialId) {
        throw new Error('User ID is required for Capacitor authentication');
      }
      await BiometricAuth.authenticate({
        reason: 'Authenticate to access your account',
        allowDeviceCredential: true,
      });
      const encryptionKey = await retrieveEncryptionKey(
        userIdOrCredentialId,
        syncFromiCloud
      );
      return { success: true, data: { encryptionKey } };
    }

    if (method === 'webauthn' && isWebAuthnSupported()) {
      if (!userIdOrCredentialId || !salt) {
        throw new Error(
          'Credential ID and salt are required for WebAuthn authentication'
        );
      }
      const data = await authenticateWithWebAuthn(userIdOrCredentialId, salt);
      return { success: true, data };
    }

    throw new Error(`Invalid or not available authentication method ${method}`);
  } catch (error) {
    console.error('Biometric authentication failed:', error);
    return { success: false, error: classifyError(error) };
  }
}

/**
 * High-level biometric auth for SecureLogin.
 * Encapsulates storage keys, salt derivation, and credential ID lookup.
 */
export async function authenticateSecureLogin(
  method: 'capacitor' | 'webauthn' | 'none'
): Promise<BiometricResult> {
  if (method === 'none') {
    return {
      success: false,
      error: 'Biometric authentication is not available',
    };
  }
  try {
    if (method === 'capacitor') {
      await BiometricAuth.authenticate({
        reason: 'Authenticate to access your account',
        allowDeviceCredential: true,
      });
      // Read directly from the fixed biometric key (no userId prefix)
      const keyBase64 = await SecureStorage.get(BIOMETRIC_STORAGE_KEY);
      if (!keyBase64 || typeof keyBase64 !== 'string') {
        throw new Error('Encryption key not found in secure storage');
      }
      const keyBytes = decodeFromBase64(keyBase64);
      const encryptionKey = await encryptionKeyFromBytes(keyBytes);
      keyBytes.fill(0);
      return { success: true, data: { encryptionKey } };
    }
    const credentialId =
      localStorage.getItem(WEBAUTHN_CREDENTIAL_ID_KEY) ?? undefined;
    const salt = await getBiometricSalt();
    return authenticate('webauthn', credentialId, salt);
  } catch (error) {
    console.error('Biometric authentication failed:', error);
    return { success: false, error: classifyError(error) };
  }
}

export function getPlatformInfo() {
  return {
    isNative,
    capacitorAvailable: isCapacitorAvailable(),
    platform: Capacitor.getPlatform(),
    webAuthnSupported: isWebAuthnSupported(),
  };
}
