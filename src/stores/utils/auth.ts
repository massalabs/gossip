import {
  EncryptionKey,
  validateMnemonic,
  decrypt,
  deriveKey,
} from '@massalabs/gossip-sdk';
import { authenticate } from '../../services/biometricService';
import { UserProfile } from '@massalabs/gossip-sdk';

export interface AuthResult {
  mnemonic: string;
  encryptionKey: EncryptionKey;
}
export async function auth(
  profile: UserProfile,
  password?: string,
  providedEncryptionKey?: EncryptionKey
): Promise<AuthResult> {
  const salt = profile.security.encKeySalt;
  if (!salt || salt.length < 8) {
    throw new Error(
      'Account is missing encryption key salt. Please re-authenticate and re-create your account after updating the app.'
    );
  }

  let encryptionKey: EncryptionKey;

  if (providedEncryptionKey) {
    // Key already derived (e.g., from SecureLogin biometric flow)
    encryptionKey = providedEncryptionKey;
  } else if (password) {
    encryptionKey = await deriveKey(password, salt);
  } else {
    // Biometric authentication (capacitor or webauthn)
    const authMethod = profile.security.authMethod;
    if (!authMethod || authMethod === 'password') {
      throw new Error('Password is required for password authentication');
    }

    const userIdOrCredentialId =
      authMethod === 'capacitor'
        ? profile.userId
        : profile.security.webauthn?.credentialId;

    const syncFromiCloud = profile.security.iCloudSync ?? false;

    const authResult = await authenticate(
      authMethod,
      userIdOrCredentialId,
      salt,
      syncFromiCloud
    );

    if (
      !authResult.success ||
      !authResult.data ||
      !authResult.data.encryptionKey
    ) {
      throw new Error(authResult.error || 'Biometric authentication failed');
    }
    encryptionKey = authResult.data.encryptionKey;
  }

  try {
    const mnemonic = await decrypt(
      profile.security.mnemonicBackup.encryptedMnemonic,
      salt,
      encryptionKey
    );

    if (!validateMnemonic(mnemonic)) {
      throw new Error('Failed to validate mnemonic');
    }

    return {
      mnemonic,
      encryptionKey,
    };
  } catch (error) {
    throw new Error(
      `Authentication failed: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}
