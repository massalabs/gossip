import { EncryptionKey } from '../../assets/generated/wasm/gossip_wasm';
import { validateMnemonic } from '../../crypto/bip39';
import { decrypt, deriveKey } from '../../crypto/encryption';
import { biometricService } from '../../services/biometricService';
import { UserProfile } from '../../db';

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

  let encryptionKey: EncryptionKey;

  const authMethod = profile.security.authMethod;
  if (!authMethod) {
    throw new Error('Account authentication method is not set');
  }

  if (authMethod === 'password') {
    if (!password) {
      throw new Error('Password is required for password authentication');
    }
    encryptionKey = await deriveKey(password, salt);
  } else {
    // For biometric authentication (capacitor or webauthn)
    const userIdOrCredentialId =
      authMethod === 'capacitor'
        ? profile.userId // For Capacitor: userId to retrieve encryption key from secure storage
        : profile.security.webauthn?.credentialId; // For WebAuthn: credential ID for PRF

    const syncFromiCloud = profile.security.iCloudSync ?? false;

    const authResult = await biometricService.authenticate(
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
