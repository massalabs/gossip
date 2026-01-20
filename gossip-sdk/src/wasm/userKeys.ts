/**
 * User Keys Support
 *
 * This file provides proxy functions for user key generation,
 * ensuring proper initialization before calling any WASM functions.
 */

import { ensureWasmInitialized } from './loader';
import {
  generate_user_keys as _generate_user_keys,
  UserKeys,
} from '../assets/generated/wasm/gossip_wasm';

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
