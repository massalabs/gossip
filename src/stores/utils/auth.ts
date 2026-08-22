import {
  EncryptionKey,
  validateMnemonic,
  decrypt,
  deriveKey,
  encrypt,
  generateNonce,
  UserProfile,
} from '@massalabs/gossip-sdk';

export interface AuthResult {
  mnemonic: string;
  encryptionKey: EncryptionKey;
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
    const pointer = (encryptionKey as unknown as { __wbg_ptr?: number })
      .__wbg_ptr;
    if (pointer === undefined || pointer !== 0) {
      encryptionKey.free();
    }
    throw error;
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
    const pointer = (encryptionKey as unknown as { __wbg_ptr?: number })
      .__wbg_ptr;
    if (pointer === undefined || pointer !== 0) {
      encryptionKey.free();
    }
    throw new Error(
      `Authentication failed: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}
