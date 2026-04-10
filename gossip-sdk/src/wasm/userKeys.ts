/**
 * User Keys Support
 *
 * This file provides proxy functions for user key generation,
 * ensuring proper initialization before calling any WASM functions.
 */

import { ensureWasmInitialized } from './loader.js';
import {
  generate_user_keys as _generate_user_keys,
  UserKeys,
} from './bindings.js';

// Re-export classes
export { UserKeys };

/**
 * Generate user keys from a BIP39 mnemonic.
 *
 * Derives gossip keys (DSA, KEM, Massa) and the EVM address in a single
 * WASM call. The EVM address is available via `keys.evm_address()`.
 */
export async function generateUserKeys(passphrase: string): Promise<UserKeys> {
  await ensureWasmInitialized();
  return _generate_user_keys(passphrase);
}
