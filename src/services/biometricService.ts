import { logger } from '../utils/logger.ts';
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
  decrypt,
  encrypt,
  generateNonce,
  decodeFromBase64,
  encodeToBase64,
  EncryptionKey,
} from '@massalabs/gossip-sdk';
import {
  BIOMETRIC_STORAGE_KEY,
  WEBAUTHN_CREDENTIAL_ID_KEY,
  WEBAUTHN_PASSWORD_KEY,
  getBiometricSalt,
} from '../constants/biometric';

export interface BiometricAvailability {
  available: boolean;
  biometryType?: 'fingerprint' | 'face' | 'none';
  method?: 'capacitor' | 'webauthn' | 'none';
}

export interface BiometricCredentials {
  password: string;
}

export interface BiometricResult {
  success: boolean;
  error?: string;
  data?: BiometricCredentials;
}

export interface BiometricSetupResult {
  success: boolean;
  error?: string;
}

export interface BiometricSetupTransactionResult extends BiometricSetupResult {
  rollback?: () => Promise<void>;
}

interface WebAuthnPasswordPayload {
  version: 1;
  salt: string;
  ciphertext: string;
}

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

function freeEncryptionKey(key: EncryptionKey): void {
  const pointer = (key as unknown as { __wbg_ptr?: number }).__wbg_ptr;
  if (pointer === undefined || pointer !== 0) {
    key.free();
  }
}

/**
 * Native biometric authentication is an application-level gate around an
 * ordinary OS-protected secure-storage read. It is not cryptographically bound
 * to a Keychain access-control item or Android BiometricPrompt CryptoObject.
 * That stricter hardware-backed design requires separate native integration and
 * device testing and is tracked as follow-up security hardening.
 *
 * Device PIN/pattern/passcode fallback is deliberately disabled: Gossip's
 * account threat model must not inherit the security of a potentially weak
 * device credential. The account-password form remains the fallback.
 */
async function authenticateNative(reason: string): Promise<void> {
  await BiometricAuth.authenticate({
    reason,
    allowDeviceCredential: false,
    iosFallbackTitle: '',
  });
}

async function readNativePassword(
  syncFromICloud: boolean
): Promise<string | null> {
  // Passwords are opaque strings. Date coercion would turn an ISO-looking
  // password into a Date and make a valid stored credential unreadable.
  const value = await SecureStorage.get(
    BIOMETRIC_STORAGE_KEY,
    false,
    syncFromICloud
  );
  return typeof value === 'string' && value.length > 0 ? value : null;
}

async function removeNativePassword(syncToICloud: boolean): Promise<void> {
  await SecureStorage.remove(BIOMETRIC_STORAGE_KEY, syncToICloud);
}

async function storeNativePassword(
  password: string,
  syncToICloud: boolean
): Promise<void> {
  // A synchronizable entry contains the account password itself. This preserves
  // the existing optional iCloud convenience, but expands exposure beyond one
  // device and must remain an explicit user choice.
  await SecureStorage.set(BIOMETRIC_STORAGE_KEY, password, true, syncToICloud);
}

async function restoreNativePasswords(
  previousLocal: string | null,
  previousCloud: string | null,
  isIOS: boolean
): Promise<void> {
  await removeNativePassword(false);
  if (isIOS) await removeNativePassword(true);
  if (previousLocal) await storeNativePassword(previousLocal, false);
  if (isIOS && previousCloud) await storeNativePassword(previousCloud, true);
}

async function replaceNativePassword(
  password: string,
  syncToICloud: boolean
): Promise<() => Promise<void>> {
  const isIOS = Capacitor.getPlatform() === 'ios';
  const [previousLocal, previousCloud] = isIOS
    ? await Promise.all([readNativePassword(false), readNativePassword(true)])
    : [await readNativePassword(false), null];
  const rollback = () =>
    restoreNativePasswords(previousLocal, previousCloud, isIOS);

  try {
    // The selected location is discoverable before a profile is known by
    // probing local and synchronizable Keychain namespaces. Keep exactly one
    // entry so lookup cannot return an older password from another namespace.
    await removeNativePassword(false);
    if (isIOS) await removeNativePassword(true);
    await storeNativePassword(password, isIOS ? syncToICloud : false);
    return rollback;
  } catch (error) {
    // Best-effort rollback avoids silently losing a previously working global
    // credential when replacement storage fails after authentication.
    try {
      await rollback();
    } catch (rollbackError) {
      logger.error(
        'Failed to restore previous biometric credential:',
        rollbackError
      );
    }
    throw error;
  }
}

function parseWebAuthnPayload(raw: string | null): WebAuthnPasswordPayload {
  if (!raw) {
    throw new Error('Biometric password not found');
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('Stored biometric password is invalid');
  }

  if (
    !value ||
    typeof value !== 'object' ||
    (value as Partial<WebAuthnPasswordPayload>).version !== 1 ||
    typeof (value as Partial<WebAuthnPasswordPayload>).salt !== 'string' ||
    typeof (value as Partial<WebAuthnPasswordPayload>).ciphertext !== 'string'
  ) {
    throw new Error('Stored biometric password is invalid');
  }

  return value as WebAuthnPasswordPayload;
}

function restoreWebAuthnPassword(
  credentialId: string | null,
  payload: string | null
): void {
  if (payload === null) {
    localStorage.removeItem(WEBAUTHN_PASSWORD_KEY);
  } else {
    localStorage.setItem(WEBAUTHN_PASSWORD_KEY, payload);
  }
  if (credentialId === null) {
    localStorage.removeItem(WEBAUTHN_CREDENTIAL_ID_KEY);
  } else {
    localStorage.setItem(WEBAUTHN_CREDENTIAL_ID_KEY, credentialId);
  }
}

async function storeWebAuthnPassword(
  password: string
): Promise<() => Promise<void>> {
  const prfSalt = await getBiometricSalt();
  const { credentialId, encryptionKey } =
    await createWebAuthnCredential(prfSalt);
  const encryptionSalt = (await generateNonce()).to_bytes();

  try {
    const { encryptedData } = await encrypt(
      password,
      encryptionKey,
      encryptionSalt
    );
    const payload: WebAuthnPasswordPayload = {
      version: 1,
      salt: encodeToBase64(encryptionSalt),
      ciphertext: encodeToBase64(encryptedData),
    };

    const previousCredentialId = localStorage.getItem(
      WEBAUTHN_CREDENTIAL_ID_KEY
    );
    const previousPayload = localStorage.getItem(WEBAUTHN_PASSWORD_KEY);

    try {
      localStorage.setItem(WEBAUTHN_PASSWORD_KEY, JSON.stringify(payload));
      localStorage.setItem(WEBAUTHN_CREDENTIAL_ID_KEY, credentialId);
      return async () => {
        restoreWebAuthnPassword(previousCredentialId, previousPayload);
      };
    } catch (error) {
      restoreWebAuthnPassword(previousCredentialId, previousPayload);
      throw error;
    }
  } finally {
    encryptionSalt.fill(0);
    freeEncryptionKey(encryptionKey);
  }
}

async function retrieveWebAuthnPassword(): Promise<string> {
  const credentialId = localStorage.getItem(WEBAUTHN_CREDENTIAL_ID_KEY);
  if (!credentialId) {
    throw new Error('Biometric credential not found');
  }

  const payload = parseWebAuthnPayload(
    localStorage.getItem(WEBAUTHN_PASSWORD_KEY)
  );
  const prfSalt = await getBiometricSalt();
  const { encryptionKey } = await authenticateWithWebAuthn(
    credentialId,
    prfSalt
  );
  let encryptionSalt: Uint8Array | undefined;
  let ciphertext: Uint8Array | undefined;

  try {
    try {
      encryptionSalt = decodeFromBase64(payload.salt);
      ciphertext = decodeFromBase64(payload.ciphertext);
    } catch {
      throw new Error('Stored biometric password is invalid');
    }
    return await decrypt(ciphertext, encryptionSalt, encryptionKey);
  } finally {
    encryptionSalt?.fill(0);
    ciphertext?.fill(0);
    freeEncryptionKey(encryptionKey);
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
      logger.warn('Capacitor biometric not available:', error);
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
      logger.info(
        '[biometric][availability] WebAuthn unavailable after preflight',
        { platformAvailable, prfSupported }
      );
    } catch (error) {
      logger.warn('WebAuthn not available:', error);
    }
  }

  return { available: false, biometryType: 'none', method: 'none' };
}

export async function configureBiometricLoginWithRollback(
  password: string,
  syncToICloud = false
): Promise<BiometricSetupTransactionResult> {
  if (!password.trim()) {
    return { success: false, error: 'Password is required' };
  }

  try {
    if (isCapacitorAvailable()) {
      await authenticateNative('Authenticate to enable biometric login');
      const rollback = await replaceNativePassword(password, syncToICloud);
      return { success: true, rollback };
    }

    if (isWebAuthnSupported()) {
      const rollback = await storeWebAuthnPassword(password);
      return { success: true, rollback };
    }

    throw new Error('Biometric authentication is not available');
  } catch (error) {
    logger.error('Biometric credential setup failed:', error);
    return {
      success: false,
      error: classifyError(error),
    };
  }
}

export async function configureBiometricLogin(
  password: string,
  syncToICloud = false
): Promise<BiometricSetupResult> {
  const { success, error } = await configureBiometricLoginWithRollback(
    password,
    syncToICloud
  );
  return error === undefined ? { success } : { success, error };
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

/**
 * Recover the singleton password after biometric authentication. The result
 * deliberately contains no account/profile/slot identifier; normal login uses
 * the password to discover the matching secure slot or classic profile.
 */
export async function authenticateBiometricLogin(
  method: 'capacitor' | 'webauthn' | 'none'
): Promise<BiometricResult> {
  if (method === 'none') {
    return {
      success: false,
      error: 'Biometric authentication is not available',
    };
  }

  try {
    if (method === 'capacitor' && isCapacitorAvailable()) {
      await authenticateNative('Authenticate to access your account');

      // The location choice is intentionally not profile metadata: login runs
      // before an account is known. Exactly one namespace should contain the
      // credential; probing local then iCloud reliably finds either choice.
      const localPassword = await readNativePassword(false);
      const password = localPassword ?? (await readNativePassword(true));
      if (!password) {
        throw new Error('Biometric password not found');
      }
      return { success: true, data: { password } };
    }

    if (method === 'webauthn' && isWebAuthnSupported()) {
      const password = await retrieveWebAuthnPassword();
      return { success: true, data: { password } };
    }

    throw new Error(`Invalid or unavailable authentication method ${method}`);
  } catch (error) {
    logger.error('Biometric authentication failed:', error);
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
