import { UserProfile } from '@massalabs/gossip-sdk';

import {
  encrypt,
  deriveKey,
  EncryptionKey,
  generateNonce,
} from '@massalabs/gossip-sdk';
import { createCredential } from '../../services/biometricService';
import {
  getBiometricSalt,
  WEBAUTHN_CREDENTIAL_ID_KEY,
} from '../../constants/biometric';

export type accountProvisionResult = {
  encryptionKey: EncryptionKey;
  security: UserProfile['security'];
};

export async function provisionAccount(
  username: string,
  mnemonic: string | undefined,
  userIdBytes: Uint8Array,
  opts: { useBiometrics: boolean; password?: string; iCloudSync?: boolean }
): Promise<accountProvisionResult> {
  if (opts.useBiometrics) {
    return await buildSecurityFromBiometrics(
      mnemonic,
      username,
      userIdBytes,
      opts.iCloudSync ?? false
    );
  } else {
    const password = opts.password?.trim();
    if (!password) {
      throw new Error('Password is required');
    }
    return await buildSecurityFromPassword(mnemonic, password);
  }
}

// Helpers to build security blobs and in-memory keys
export async function buildSecurityFromPassword(
  mnemonic: string | undefined,
  password: string
): Promise<{
  security: UserProfile['security'];
  encryptionKey: EncryptionKey;
}> {
  const salt = (await generateNonce()).to_bytes();
  const key = await deriveKey(password, salt);

  if (!mnemonic) {
    throw new Error('Mnemonic is required for account creation');
  }

  const { encryptedData: encryptedMnemonic } = await encrypt(
    mnemonic,
    key,
    salt
  );
  const mnemonicBackup: UserProfile['security']['mnemonicBackup'] = {
    encryptedMnemonic,
    createdAt: new Date(),
    backedUp: false,
  };

  const security: UserProfile['security'] = {
    authMethod: 'password',
    encKeySalt: salt,
    mnemonicBackup,
  };

  return { security, encryptionKey: key };
}

export async function buildSecurityFromBiometrics(
  mnemonic: string | undefined,
  username: string,
  userIdBytes: Uint8Array,
  iCloudSync = false
): Promise<{
  security: UserProfile['security'];
  encryptionKey: EncryptionKey;
}> {
  if (!mnemonic) {
    throw new Error('Mnemonic is required for account creation');
  }

  // WebAuthn PRF needs the fixed biometric salt; Capacitor ignores it.
  // Mnemonic encryption uses a separate random salt.
  const prfSalt = await getBiometricSalt();
  const encSalt = (await generateNonce()).to_bytes();

  const credentialResult = await createCredential(
    `Gossip:${username}`,
    userIdBytes,
    prfSalt,
    iCloudSync
  );

  if (!credentialResult.success || !credentialResult.data) {
    throw new Error(
      credentialResult.error || 'Failed to create biometric credential'
    );
  }

  const { credentialId, encryptionKey, authMethod } = credentialResult.data;

  // Persist WebAuthn credential ID for login discovery
  if (credentialId) {
    localStorage.setItem(WEBAUTHN_CREDENTIAL_ID_KEY, credentialId);
  }

  const { encryptedData } = await encrypt(mnemonic, encryptionKey, encSalt);

  const mnemonicBackup: UserProfile['security']['mnemonicBackup'] = {
    encryptedMnemonic: encryptedData,
    createdAt: new Date(),
    backedUp: false,
  };

  const security: UserProfile['security'] = {
    authMethod,
    webauthn: credentialId
      ? {
          credentialId,
        }
      : undefined,
    iCloudSync,
    encKeySalt: encSalt,
    mnemonicBackup,
  };

  return { security, encryptionKey };
}
