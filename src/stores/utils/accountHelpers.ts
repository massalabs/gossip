import { logger } from '../../utils/logger.ts';
import {
  generateUserKeys,
  IDENTITY_DERIVATION_VERSION,
  UserProfile,
} from '@massalabs/gossip-sdk';
import { Account, PrivateKey, Provider } from '@massalabs/massa-web3';
import { useAppStore } from '../appStore';

export function wipeAccountPrivateKey(
  account: Account | null | undefined
): void {
  const privateKey = (account as Partial<Account> | null | undefined)
    ?.privateKey;
  privateKey?.toBytes().fill(0);
}

export async function deriveAccountFromMnemonic(
  mnemonic: string,
  identityDerivationVersion: number = IDENTITY_DERIVATION_VERSION
): Promise<{
  account: Account;
  userIdBytes: Uint8Array;
  evmAddress: string;
  massaAddress: string;
}> {
  if (identityDerivationVersion !== IDENTITY_DERIVATION_VERSION) {
    throw new Error('Unsupported identity derivation version');
  }
  return deriveAccountFromMnemonicV1(mnemonic);
}

async function deriveAccountFromMnemonicV1(mnemonic: string): Promise<{
  account: Account;
  userIdBytes: Uint8Array;
  evmAddress: string;
  massaAddress: string;
}> {
  const keys = await generateUserKeys(mnemonic);
  let secretKeys: ReturnType<typeof keys.secret_keys> | undefined;
  let publicKeys: ReturnType<typeof keys.public_keys> | undefined;
  let massaSecretKey: Uint8Array | undefined;
  let accountSecretKey: Uint8Array | undefined;
  let accountOwnsSecretKey = false;

  try {
    secretKeys = keys.secret_keys();
    publicKeys = keys.public_keys();
    massaSecretKey = secretKeys.massa_secret_key;
    // massa-web3 retains the exact array passed to PrivateKey.fromBytes().
    // Give the returned Account its own buffer before wiping WASM output.
    accountSecretKey = new Uint8Array(massaSecretKey);
    const account = await Account.fromPrivateKey(
      PrivateKey.fromBytes(accountSecretKey)
    );
    const userIdBytes = publicKeys.derive_id();
    const evmAddress = keys.evm_address();
    const massaAddress = keys.massa_address();
    accountOwnsSecretKey = true;
    return { account, userIdBytes, evmAddress, massaAddress };
  } finally {
    if (!accountOwnsSecretKey) accountSecretKey?.fill(0);
    massaSecretKey?.fill(0);
    secretKeys?.free();
    publicKeys?.free();
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
