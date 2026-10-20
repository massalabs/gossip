import {
  UserPublicKeys,
  decodeUserId,
  encodeUserId,
} from '@massalabs/gossip-sdk';
import { type ContactPayload, sameBytes } from './frame';

export interface VerifiedContact {
  userId: string;
  name?: string;
  publicKeys: UserPublicKeys;
}

/**
 * Parses the public keys and checks that they hash to `userId` (the user id
 * is the BLAKE3 hash of the keys). Null when they do not: someone else's keys.
 */
export function verifyKeysForUserId(
  userId: Uint8Array,
  keyBytes: Uint8Array
): UserPublicKeys | null {
  let keys: UserPublicKeys;
  try {
    keys = UserPublicKeys.from_bytes(keyBytes);
  } catch {
    return null;
  }
  if (!sameBytes(keys.derive_id(), userId)) {
    keys.free();
    return null;
  }
  return keys;
}

/** Same check for a `gossip1…` user id; null for an invalid id too. */
export function verifyKeysForEncodedUserId(
  userId: string,
  keyBytes: Uint8Array
): UserPublicKeys | null {
  try {
    return verifyKeysForUserId(decodeUserId(userId), keyBytes);
  } catch {
    return null;
  }
}

/** The contact of a complete payload, from the QR frames or Bluetooth, once checked. */
export function verifyContactPayload(
  payload: ContactPayload
): VerifiedContact | null {
  const keys = verifyKeysForUserId(payload.header.userId, payload.publicKeys);
  if (!keys) return null;
  return {
    userId: encodeUserId(payload.header.userId),
    ...(payload.name && { name: payload.name.slice(0, 100) }),
    publicKeys: keys,
  };
}
