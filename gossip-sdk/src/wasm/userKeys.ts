/**
 * User Keys Support
 *
 * This file provides proxy functions for user key generation,
 * ensuring proper initialization before calling any WASM functions.
 */

import { ensureWasmInitialized } from './loader.js';
import {
  generate_user_keys as _generate_user_keys,
  derive_evm_address as _derive_evm_address,
  UserKeys,
} from './bindings.js';

// Re-export classes
export { UserKeys };

/**
 * Generate user keys from a passphrase using password-based key derivation
 * This ensures WASM is initialized before calling
 *
 * @param passphrase - The user's passphrase
 * @param secondaryKey - A 32-byte secondary public key
 * @returns UserKeys object containing public and secret keys
 */
export async function generateUserKeys(passphrase: string): Promise<UserKeys> {
  await ensureWasmInitialized();
  // The actual WASM function is synchronous, so we can call it directly
  const keys = _generate_user_keys(passphrase);

  return keys;
}

/**
 * Derive an EVM address from a BIP39 mnemonic phrase.
 *
 * Uses BIP44 path `m/44'/60'/0'/0/0` and returns an EIP-55 checksummed
 * hex string (0x…). Throws if the input is not a valid BIP39 mnemonic.
 */
export async function deriveEvmAddress(mnemonic: string): Promise<string> {
  await ensureWasmInitialized();
  return _derive_evm_address(mnemonic);
}
