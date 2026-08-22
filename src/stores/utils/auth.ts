import {
  EncryptionKey,
  validateMnemonic,
  decrypt,
  deriveKey,
  UserProfile,
} from '@massalabs/gossip-sdk';

export interface AuthResult {
  mnemonic: string;
  encryptionKey: EncryptionKey;
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
