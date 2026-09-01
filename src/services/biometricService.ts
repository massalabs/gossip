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

const WEBAUTHN_PASSWORD_PAYLOAD_VERSION = 2 as const;
const MAX_WEBAUTHN_PASSWORD_BYTES = 1024;
const WEBAUTHN_PASSWORD_ENVELOPE_BYTES = 2 + MAX_WEBAUTHN_PASSWORD_BYTES;

interface WebAuthnPasswordPayload {
  version: typeof WEBAUTHN_PASSWORD_PAYLOAD_VERSION;
  credentialId: string;
  salt: string;
  ciphertext: string;
}

function encodeWebAuthnPasswordEnvelope(password: string): string {
  const passwordBytes = new TextEncoder().encode(password);
  const envelope = new Uint8Array(WEBAUTHN_PASSWORD_ENVELOPE_BYTES);
  try {
    if (passwordBytes.byteLength > MAX_WEBAUTHN_PASSWORD_BYTES) {
      throw new Error('Password is too long for biometric storage');
    }
    crypto.getRandomValues(envelope);
    new DataView(envelope.buffer).setUint16(0, passwordBytes.byteLength, false);
    envelope.set(passwordBytes, 2);
    return encodeToBase64(envelope);
  } finally {
    passwordBytes.fill(0);
    envelope.fill(0);
  }
}

function decodeWebAuthnPasswordEnvelope(encoded: string): string {
  let envelope: Uint8Array | undefined;
  try {
    envelope = decodeFromBase64(encoded);
    if (envelope.byteLength !== WEBAUTHN_PASSWORD_ENVELOPE_BYTES) {
      throw new Error('Stored biometric password is invalid');
    }
    const passwordLength = new DataView(
      envelope.buffer,
      envelope.byteOffset,
      envelope.byteLength
    ).getUint16(0, false);
    if (passwordLength === 0 || passwordLength > MAX_WEBAUTHN_PASSWORD_BYTES) {
      throw new Error('Stored biometric password is invalid');
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(
      envelope.subarray(2, 2 + passwordLength)
    );
  } catch {
    throw new Error('Stored biometric password is invalid');
  } finally {
    envelope?.fill(0);
  }
}

class BiometricRestorationRequiredError extends Error {
  declare readonly originalError: unknown;
  declare readonly rollback: () => Promise<void>;

  constructor(originalError: unknown, rollback: () => Promise<void>) {
    super('Previous biometric credential restoration is required');
    this.name = 'BiometricRestorationRequiredError';
    // Keep the recovery closure and underlying error out of enumerable log
    // payloads: native rollback may close over the previous password.
    Object.defineProperties(this, {
      originalError: { value: originalError },
      rollback: { value: rollback },
    });
  }
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
      throw new BiometricRestorationRequiredError(error, rollback);
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
    (value as Partial<WebAuthnPasswordPayload>).version !==
      WEBAUTHN_PASSWORD_PAYLOAD_VERSION ||
    typeof (value as Partial<WebAuthnPasswordPayload>).credentialId !==
      'string' ||
    !(value as Partial<WebAuthnPasswordPayload>).credentialId ||
    typeof (value as Partial<WebAuthnPasswordPayload>).salt !== 'string' ||
    typeof (value as Partial<WebAuthnPasswordPayload>).ciphertext !== 'string'
  ) {
    throw new Error('Stored biometric password is invalid');
  }

  return value as WebAuthnPasswordPayload;
}

function restoreWebAuthnPassword(record: string | null): void {
  if (record === null) {
    localStorage.removeItem(WEBAUTHN_PASSWORD_KEY);
  } else {
    localStorage.setItem(WEBAUTHN_PASSWORD_KEY, record);
  }
}

async function storeWebAuthnPassword(
  password: string
): Promise<() => Promise<void>> {
  const prfSalt = await getBiometricSalt();
  const { credentialId, encryptionKey } =
    await createWebAuthnCredential(prfSalt);
  let encryptionSalt: Uint8Array | undefined;

  try {
    encryptionSalt = (await generateNonce()).to_bytes();
    const paddedPassword = encodeWebAuthnPasswordEnvelope(password);
    const { encryptedData } = await encrypt(
      paddedPassword,
      encryptionKey,
      encryptionSalt
    );
    const payload: WebAuthnPasswordPayload = {
      version: WEBAUTHN_PASSWORD_PAYLOAD_VERSION,
      credentialId,
      salt: encodeToBase64(encryptionSalt),
      ciphertext: encodeToBase64(encryptedData),
    };

    const previousRecord = localStorage.getItem(WEBAUTHN_PASSWORD_KEY);
    const rollback = async () => {
      restoreWebAuthnPassword(previousRecord);
    };
    try {
      // The authenticator handle and its ciphertext are one logical record.
      // A single Web Storage mutation cannot expose a mismatched pair after
      // process termination.
      localStorage.setItem(WEBAUTHN_PASSWORD_KEY, JSON.stringify(payload));

      // Released pre-password builds used this handle-only key. It cannot
      // unlock the new password format and is intentionally ignored. Cleanup
      // is best-effort because the complete replacement is already committed.
      try {
        localStorage.removeItem(WEBAUTHN_CREDENTIAL_ID_KEY);
      } catch (cleanupError) {
        logger.warn(
          'Failed to remove legacy WebAuthn credential:',
          cleanupError
        );
      }
      return rollback;
    } catch (error) {
      try {
        await rollback();
      } catch (rollbackError) {
        logger.error(
          'Failed to restore previous WebAuthn credential:',
          rollbackError
        );
        throw new BiometricRestorationRequiredError(error, rollback);
      }
      throw error;
    }
  } finally {
    encryptionSalt?.fill(0);
    freeEncryptionKey(encryptionKey);
  }
}

async function retrieveWebAuthnPassword(): Promise<string> {
  const payload = parseWebAuthnPayload(
    localStorage.getItem(WEBAUTHN_PASSWORD_KEY)
  );
  const prfSalt = await getBiometricSalt();
  const { encryptionKey } = await authenticateWithWebAuthn(
    payload.credentialId,
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
    const paddedPassword = await decrypt(
      ciphertext,
      encryptionSalt,
      encryptionKey
    );
    return decodeWebAuthnPasswordEnvelope(paddedPassword);
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
    if (error instanceof BiometricRestorationRequiredError) {
      return {
        success: false,
        error: classifyError(error.originalError),
        rollback: error.rollback,
      };
    }
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
  const result = await configureBiometricLoginWithRollback(
    password,
    syncToICloud
  );
  if (!result.success && result.rollback) {
    try {
      await result.rollback();
    } catch (rollbackError) {
      logger.error(
        'Failed to retry previous biometric credential restoration:',
        rollbackError
      );
      return { success: false, error: 'biometric_restoration_failed' };
    }
  }
  const { success, error } = result;
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
