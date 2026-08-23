import { logger } from '../../utils/logger.ts';
import { generateUserKeys, UserProfile } from '@massalabs/gossip-sdk';
import { Account, PrivateKey, Provider } from '@massalabs/massa-web3';
import { useAppStore } from '../appStore';

export async function deriveAccountFromMnemonic(mnemonic: string): Promise<{
  account: Account;
  userIdBytes: Uint8Array;
  evmAddress: string;
  massaAddress: string;
}> {
  const keys = await generateUserKeys(mnemonic);
  const secretKeys = keys.secret_keys();
  const publicKeys = keys.public_keys();
  const massaSecretKey = secretKeys.massa_secret_key;
  try {
    const account = await Account.fromPrivateKey(
      PrivateKey.fromBytes(massaSecretKey)
    );
    const userIdBytes = publicKeys.derive_id();
    const evmAddress = keys.evm_address();
    const massaAddress = keys.massa_address();
    return { account, userIdBytes, evmAddress, massaAddress };
  } finally {
    massaSecretKey.fill(0);
    secretKeys.free();
    publicKeys.free();
    keys.free();
  }
}

export function fetchMnsDomainsIfEnabled(
  profile: UserProfile,
  provider: Provider | null
): void {
  const { mnsEnabled } = useAppStore.getState();
  if (!mnsEnabled || !provider) return;

  useAppStore
    .getState()
    .fetchMnsDomains(profile, provider)
    .catch(error => {
      logger.error('Error fetching MNS domains:', error);
    });
}
