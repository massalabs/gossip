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
  const account = await Account.fromPrivateKey(
    PrivateKey.fromBytes(keys.secret_keys().massa_secret_key)
  );
  const userIdBytes = keys.public_keys().derive_id();
  const evmAddress = keys.evm_address();
  const massaAddress = keys.massa_address();
  return { account, userIdBytes, evmAddress, massaAddress };
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
      console.error('Error fetching MNS domains:', error);
    });
}
