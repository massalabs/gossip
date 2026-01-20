/**
 * User ID encoding/decoding utilities using Bech32 format
 * Format: gossip1<encoded-32-bytes>
 *
 * Uses @scure/base for reliable, battle-tested Bech32 encoding
 */

import { bech32 } from '@scure/base';
import { generateUserKeys } from '../wasm';

const GOSSIP_PREFIX = 'gossip';
const USER_ID_BYTE_LENGTH = 32;

/**
 * Encode a 32-byte user ID to Bech32 format with "gossip" prefix
 * @param userId - 32-byte user ID as Uint8Array
 * @returns Bech32-encoded string (e.g., "gossip1qpzry9x8gf2tvdw0s3jn54khce6mua7l...")
 * @throws Error if userId is not exactly 32 bytes
 */
export function encodeUserId(userId: Uint8Array): string {
  if (userId.length !== USER_ID_BYTE_LENGTH) {
    throw new Error(
      `User ID must be exactly ${USER_ID_BYTE_LENGTH} bytes, got ${userId.length}`
    );
  }

  return bech32.encode(GOSSIP_PREFIX, bech32.toWords(userId));
}

/**
 * Decode a Bech32-encoded user ID back to 32 bytes
 * @param encoded - Bech32-encoded string (e.g., "gossip1qpzry9x8gf2tvdw0s3jn54khce6mua7l...")
 * @returns 32-byte user ID as Uint8Array
 * @throws Error if the format is invalid, checksum fails, or decoded length is not 32 bytes
 */
export function decodeUserId(encoded: string): Uint8Array {
  // Type assertion needed as bech32.decode expects a template literal type
  const { prefix, words } = bech32.decode(encoded as `${string}1${string}`, 90);

  // Verify prefix
  if (prefix !== GOSSIP_PREFIX) {
    throw new Error(
      `Invalid prefix: expected "${GOSSIP_PREFIX}", got "${prefix}"`
    );
  }

  // Convert from 5-bit words back to bytes
  const decoded = bech32.fromWords(words);

  // Verify length
  if (decoded.length !== USER_ID_BYTE_LENGTH) {
    throw new Error(
      `Decoded user ID must be ${USER_ID_BYTE_LENGTH} bytes, got ${decoded.length}`
    );
  }

  return new Uint8Array(decoded);
}

/**
 * Validate a Bech32-encoded user ID string
 * @param encoded - Bech32-encoded string to validate
 * @returns true if valid, false otherwise
 */
export function isValidUserId(encoded: string): boolean {
  try {
    decodeUserId(encoded);
    return true;
  } catch {
    return false;
  }
}

/**
 * Format a user ID for display (shortened version)
 * @param userId - Bech32-encoded user ID string
 * @param prefixChars - Number of characters to show after prefix (default: 8)
 * @param suffixChars - Number of characters to show at end (default: 6)
 * @returns Formatted string (e.g., "gossip1qpzry9x8...mua7l")
 */
export function formatUserId(
  userId: string,
  prefixChars: number = 8,
  suffixChars: number = 6
): string {
  if (!userId) return '';

  // Find separator position
  const sepPos = userId.indexOf('1');
  if (sepPos === -1) return userId;

  const prefix = userId.substring(0, sepPos + 1); // "gossip1"
  const data = userId.substring(sepPos + 1); // rest of the string

  if (data.length <= prefixChars + suffixChars) {
    return userId; // Too short to format
  }

  const start = data.slice(0, prefixChars);
  const end = data.slice(-suffixChars);

  return `${prefix}${start}...${end}`;
}

/**
 * Generates a random 32-byte user ID
 * @param password - Optional password
 * @returns gossip Bech32 string representing a 32-byte user ID
 */
export async function generate(password?: string): Promise<string> {
  const identity = await generateUserKeys(password || '');
  const userId = identity.public_keys().derive_id();
  return encodeUserId(userId);
}
