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
  // massa-web3 retains the exact Uint8Array passed to PrivateKey.fromBytes().
  // Give the returned Account its own buffer so wiping the transient WASM
  // output below cannot erase the account's live signing key.
  const accountSecretKey = new Uint8Array(massaSecretKey);
  let accountOwnsSecretKey = false;
  try {
    const account = await Account.fromPrivateKey(
      PrivateKey.fromBytes(accountSecretKey)
    );
    const userIdBytes = publicKeys.derive_id();
    const evmAddress = keys.evm_address();
    const massaAddress = keys.massa_address();
    accountOwnsSecretKey = true;
    return { account, userIdBytes, evmAddress, massaAddress };
  } finally {
    if (!accountOwnsSecretKey) accountSecretKey.fill(0);
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
