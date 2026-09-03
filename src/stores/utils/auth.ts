import {
  EncryptionKey,
  IDENTITY_DERIVATION_VERSION,
  PROFILE_MNEMONIC_ENCRYPTION_VERSION,
  PROFILE_PASSWORD_KDF_VERSION,
  PROFILE_SECURITY_FORMAT_VERSION,
  validateMnemonic,
  decrypt,
  deriveKey,
  encrypt,
  generateNonce,
  generateUserKeys,
  SessionModule,
  UserProfile,
} from '@massalabs/gossip-sdk';

export interface AuthResult {
  mnemonic: string;
  encryptionKey: EncryptionKey;
}

export interface PreparedPasswordAccount {
  mnemonicBytes: Uint8Array;
  security: UserProfile['security'];
  encryptedSession: Uint8Array;
}

function freeEncryptionKey(key: EncryptionKey): void {
  const pointer = (key as unknown as { __wbg_ptr?: number }).__wbg_ptr;
  if (pointer === undefined || pointer !== 0) {
    key.free();
  }
}

export async function createPasswordSecurity(
  mnemonic: string,
  password: string
): Promise<{
  security: UserProfile['security'];
  encryptionKey: EncryptionKey;
}> {
  if (!mnemonic) {
    throw new Error('Mnemonic is required for account creation');
  }

  const salt = (await generateNonce()).to_bytes();
  const encryptionKey = await deriveProfileEncryptionKeyV1(password, salt);

  try {
    const encryptedMnemonic = await encryptMnemonicV1(
      mnemonic,
      encryptionKey,
      salt
    );
    return {
      security: {
        formatVersion: PROFILE_SECURITY_FORMAT_VERSION,
        passwordKdfVersion: PROFILE_PASSWORD_KDF_VERSION,
        mnemonicEncryptionVersion: PROFILE_MNEMONIC_ENCRYPTION_VERSION,
        identityDerivationVersion: IDENTITY_DERIVATION_VERSION,
        authMethod: 'password',
        encKeySalt: salt,
        mnemonicBackup: {
          encryptedMnemonic,
          createdAt: new Date(),
          backedUp: false,
        },
      },
      encryptionKey,
    };
  } catch (error) {
    freeEncryptionKey(encryptionKey);
    throw error;
  }
}

export function wipePreparedPasswordAccount(
  prepared: PreparedPasswordAccount
): void {
  prepared.mnemonicBytes.fill(0);
  prepared.encryptedSession.fill(0);
  prepared.security.encKeySalt.fill(0);
  prepared.security.mnemonicBackup.encryptedMnemonic.fill(0);
}

export async function preparePasswordAccount(
  mnemonic: string,
  password: string,
  mnemonicAlreadyBackedUp = false
): Promise<PreparedPasswordAccount> {
  const mnemonicBytes = new TextEncoder().encode(mnemonic);
  let security: UserProfile['security'] | undefined;
  let encryptionKey: EncryptionKey | undefined;
  let authenticatedKey: EncryptionKey | undefined;
  let encryptedSession: Uint8Array | undefined;
  let initialKeys: Awaited<ReturnType<typeof generateUserKeys>> | undefined;
  let reopenedKeys: Awaited<ReturnType<typeof generateUserKeys>> | undefined;
  let initialSession: SessionModule | undefined;
  let reopenedSession: SessionModule | undefined;

  try {
    ({ security, encryptionKey } = await createPasswordSecurity(
      mnemonic,
      password
    ));
    security.mnemonicBackup.backedUp = mnemonicAlreadyBackedUp;
    // Prove the password decrypts the exact in-RAM identity before any account
    // data reaches durable storage.
    const authenticated = await auth({ security } as UserProfile, password);
    authenticatedKey = authenticated.encryptionKey;
    if (authenticated.mnemonic !== mnemonic) {
      throw new Error('Prepared account mnemonic mismatch');
    }

    initialKeys = await generateUserKeys(mnemonic);
    initialSession = new SessionModule(initialKeys);
    initialKeys.free();
    initialKeys = undefined;
    encryptedSession = initialSession.toEncryptedBlob(encryptionKey);
    initialSession.dispose();
    initialSession = undefined;

    // Lock/reopen the exact encrypted session in RAM with the independently
    // derived password key. The validation serialization is immediately wiped.
    reopenedKeys = await generateUserKeys(authenticated.mnemonic);
    reopenedSession = new SessionModule(reopenedKeys);
    reopenedKeys.free();
    reopenedKeys = undefined;
    reopenedSession.load(encryptedSession, authenticatedKey);
    const validationBlob = reopenedSession.toEncryptedBlob(authenticatedKey);
    validationBlob.fill(0);

    return { mnemonicBytes, security, encryptedSession };
  } catch (error) {
    mnemonicBytes.fill(0);
    encryptedSession?.fill(0);
    security?.encKeySalt.fill(0);
    security?.mnemonicBackup.encryptedMnemonic.fill(0);
    throw error;
  } finally {
    initialKeys?.free();
    reopenedKeys?.free();
    initialSession?.dispose();
    reopenedSession?.dispose();
    if (encryptionKey) freeEncryptionKey(encryptionKey);
    if (authenticatedKey) freeEncryptionKey(authenticatedKey);
  }
}

const MAX_ENCRYPTED_MNEMONIC_BYTES = 64 * 1024;

export async function deriveProfileEncryptionKeyV1(
  password: string,
  salt: Uint8Array
): Promise<EncryptionKey> {
  return deriveKey(password, salt);
}

export async function encryptMnemonicV1(
  mnemonic: string,
  encryptionKey: EncryptionKey,
  salt: Uint8Array
): Promise<Uint8Array> {
  const { encryptedData } = await encrypt(mnemonic, encryptionKey, salt);
  return encryptedData;
}

async function decryptMnemonicV1(
  encryptedMnemonic: Uint8Array,
  salt: Uint8Array,
  encryptionKey: EncryptionKey
): Promise<string> {
  return decrypt(encryptedMnemonic, salt, encryptionKey);
}

export async function auth(
  profile: UserProfile,
  password?: string
): Promise<AuthResult> {
  const rawSecurity = profile.security as unknown;
  if (
    typeof rawSecurity !== 'object' ||
    rawSecurity === null ||
    Array.isArray(rawSecurity)
  ) {
    throw new Error('Unsupported account security format');
  }
  const security = rawSecurity as Partial<UserProfile['security']>;
  if (
    security.formatVersion !== PROFILE_SECURITY_FORMAT_VERSION ||
    security.passwordKdfVersion !== PROFILE_PASSWORD_KDF_VERSION ||
    security.mnemonicEncryptionVersion !==
      PROFILE_MNEMONIC_ENCRYPTION_VERSION ||
    security.identityDerivationVersion !== IDENTITY_DERIVATION_VERSION
  ) {
    throw new Error('Unsupported account security format');
  }

  const salt = security.encKeySalt;
  const mnemonicBackup = security.mnemonicBackup as unknown;
  const encryptedMnemonic =
    typeof mnemonicBackup === 'object' &&
    mnemonicBackup !== null &&
    !Array.isArray(mnemonicBackup)
      ? (mnemonicBackup as Record<string, unknown>).encryptedMnemonic
      : undefined;
  if (!(salt instanceof Uint8Array) || salt.length !== 16) {
    throw new Error(
      'Account is missing encryption key salt. Please re-authenticate and re-create your account after updating the app.'
    );
  }
  if (
    !(encryptedMnemonic instanceof Uint8Array) ||
    encryptedMnemonic.length < 17 ||
    encryptedMnemonic.length > MAX_ENCRYPTED_MNEMONIC_BYTES
  ) {
    throw new Error('Account has an invalid encrypted mnemonic');
  }
  if (security.authMethod !== 'password') {
    throw new Error('Unsupported account authentication method');
  }
  if (!password) {
    throw new Error('Password is required for authentication');
  }

  const encryptionKey = await deriveProfileEncryptionKeyV1(password, salt);

  try {
    const mnemonic = await decryptMnemonicV1(
      encryptedMnemonic,
      salt,
      encryptionKey
    );

    if (!validateMnemonic(mnemonic)) {
      throw new Error('Failed to validate mnemonic');
    }

    return { mnemonic, encryptionKey };
  } catch (error) {
    freeEncryptionKey(encryptionKey);
    throw new Error(
      `Authentication failed: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}
