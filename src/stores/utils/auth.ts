import {
  EncryptionKey,
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
  const encryptionKey = await deriveKey(password, salt);

  try {
    const { encryptedData: encryptedMnemonic } = await encrypt(
      mnemonic,
      encryptionKey,
      salt
    );
    return {
      security: {
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
  password: string
): Promise<PreparedPasswordAccount> {
  const mnemonicBytes = new TextEncoder().encode(mnemonic);
  const { security, encryptionKey } = await createPasswordSecurity(
    mnemonic,
    password
  );
  let authenticatedKey: EncryptionKey | undefined;
  let encryptedSession: Uint8Array | undefined;
  let initialSession: SessionModule | undefined;
  let reopenedSession: SessionModule | undefined;

  try {
    // Prove the password decrypts the exact in-RAM identity before any account
    // data reaches durable storage.
    const authenticated = await auth({ security } as UserProfile, password);
    authenticatedKey = authenticated.encryptionKey;
    if (authenticated.mnemonic !== mnemonic) {
      throw new Error('Prepared account mnemonic mismatch');
    }

    const initialKeys = await generateUserKeys(mnemonic);
    initialSession = new SessionModule(initialKeys);
    encryptedSession = initialSession.toEncryptedBlob(encryptionKey);
    initialSession.cleanup();
    initialSession = undefined;

    // Lock/reopen the exact encrypted session in RAM with the independently
    // derived password key. The validation serialization is immediately wiped.
    const reopenedKeys = await generateUserKeys(authenticated.mnemonic);
    reopenedSession = new SessionModule(reopenedKeys);
    reopenedSession.load(encryptedSession, authenticatedKey);
    const validationBlob = reopenedSession.toEncryptedBlob(authenticatedKey);
    validationBlob.fill(0);

    return { mnemonicBytes, security, encryptedSession };
  } catch (error) {
    mnemonicBytes.fill(0);
    encryptedSession?.fill(0);
    security.encKeySalt.fill(0);
    security.mnemonicBackup.encryptedMnemonic.fill(0);
    throw error;
  } finally {
    initialSession?.cleanup();
    reopenedSession?.cleanup();
    freeEncryptionKey(encryptionKey);
    if (authenticatedKey) freeEncryptionKey(authenticatedKey);
  }
}

export async function auth(
  profile: UserProfile,
  password?: string
): Promise<AuthResult> {
  const salt = profile.security.encKeySalt;
  if (!salt || salt.length < 8) {
    throw new Error(
      'Account is missing encryption key salt. Please re-authenticate and re-create your account after updating the app.'
    );
  }
  if (!password) {
    throw new Error('Password is required for authentication');
  }

  const encryptionKey = await deriveKey(password, salt);

  try {
    const mnemonic = await decrypt(
      profile.security.mnemonicBackup.encryptedMnemonic,
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
