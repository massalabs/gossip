/**
 * Addressing Blob - Maps passwords to session locations
 *
 * The addressing blob is a fixed 2MB structure containing 65,536 slots of 32 bytes each.
 * Each session writes its address to 46 pseudo-random slots derived from the password.
 *
 * This redundancy ensures collision probability remains below 10⁻¹² even with
 * 1,024 concurrent sessions.
 *
 * @module core/AddressingBlob
 */

import type { SessionAddress } from '../types';

/**
 * Constants for addressing blob structure
 */
export const ADDRESSING_BLOB_SIZE = 2 * 1024 * 1024; // 2 MB
export const SLOT_SIZE = 32; // bytes per slot
export const SLOT_COUNT = ADDRESSING_BLOB_SIZE / SLOT_SIZE; // 65,536 slots
export const SLOTS_PER_SESSION = 46; // redundancy factor

/**
 * Creates an empty addressing blob filled with random data
 *
 * The blob is initialized with cryptographically secure random data to ensure
 * that empty slots are indistinguishable from occupied ones.
 *
 * @returns A 2MB Uint8Array filled with random data
 *
 * @example
 * ```typescript
 * const blob = createAddressingBlob();
 * console.log(blob.length); // 2097152 (2MB)
 * ```
 */
export function createAddressingBlob(): Uint8Array {
  const blob = new Uint8Array(ADDRESSING_BLOB_SIZE);
  crypto.getRandomValues(blob);
  return blob;
}

/**
 * Derives 46 unique slot indices from a password
 *
 * Uses Argon2id (via WASM EncryptionKey.from_seed) to derive pseudo-random bytes,
 * then maps them to slot indices in [0..65535]. This ensures:
 * - Deterministic: same password always gives same indices
 * - Uniform distribution across all slots
 * - Cryptographically secure derivation (Argon2id KDF)
 *
 * @param password - The password to derive indices from
 * @returns Array of 46 unique slot indices
 *
 * @example
 * ```typescript
 * const indices = await deriveSlotIndices('my-password');
 * console.log(indices.length); // 46
 * console.log(indices[0]); // e.g., 42391
 * ```
 */
export async function deriveSlotIndices(
  password: string,
): Promise<number[]> {
  // Use WASM EncryptionKey.from_seed for Argon2id-based derivation
  const { generateEncryptionKeyFromSeed } = await import(
    '../../../wasm/encryption'
  );

  // Fixed salt for slot derivation (deterministic per password)
  const salt = new TextEncoder().encode('deniable-storage-slot-v1');

  // Derive 64 bytes using Argon2id
  const key = await generateEncryptionKeyFromSeed(password, salt);
  const derivedBytes = key.to_bytes();

  // Convert bytes to slot indices
  // We need 46 unique indices in range [0..65535]
  const indices: number[] = [];
  const seenIndices = new Set<number>();

  // Use all 64 bytes (32 potential indices)
  for (
    let i = 0;
    i < derivedBytes.length - 1 && indices.length < SLOTS_PER_SESSION;
    i += 2
  ) {
    // Read 2 bytes as uint16 (big-endian)
    const index = (derivedBytes[i] << 8) | derivedBytes[i + 1];

    // Only add if not already seen (ensure uniqueness)
    if (!seenIndices.has(index)) {
      indices.push(index);
      seenIndices.add(index);
    }
  }

  // If we don't have enough unique indices from first 64 bytes,
  // derive more by appending a counter to the password
  let counter = 1;
  while (indices.length < SLOTS_PER_SESSION) {
    const extendedPassword = `${password}:${counter}`;
    const extraKey = await generateEncryptionKeyFromSeed(extendedPassword, salt);
    const extraBytes = extraKey.to_bytes();

    for (let i = 0; i < extraBytes.length - 1 && indices.length < SLOTS_PER_SESSION; i += 2) {
      const index = (extraBytes[i] << 8) | extraBytes[i + 1];
      if (!seenIndices.has(index)) {
        indices.push(index);
        seenIndices.add(index);
      }
    }

    counter++;

    // Safety check to avoid infinite loop
    if (counter > 10) {
      throw new Error(
        `Failed to derive enough unique slot indices (got ${indices.length}, need ${SLOTS_PER_SESSION})`,
      );
    }
  }

  return indices.slice(0, SLOTS_PER_SESSION);
}

/**
 * Writes a session address to a specific slot using AEAD encryption
 *
 * The slot is encrypted with AES-256-SIV using a key derived from the password.
 * Format: [nonce(16 bytes)][ciphertext(variable)]
 *
 * @param blob - The addressing blob to write to
 * @param slotIndex - The slot index [0..65535]
 * @param address - The session address to write
 * @param password - Password to derive encryption key
 *
 * @example
 * ```typescript
 * const blob = createAddressingBlob();
 * const address = { offset: 1024, blockSize: 35000000, ... };
 * await writeSlot(blob, 42391, address, 'my-password');
 * ```
 */
export async function writeSlot(
  blob: Uint8Array,
  slotIndex: number,
  address: SessionAddress,
  password: string,
): Promise<void> {
  const {
    generateEncryptionKeyFromSeed,
    generateNonce,
    encryptAead,
  } = await import('../../../wasm/encryption');

  // Validate slot index
  if (slotIndex < 0 || slotIndex >= SLOT_COUNT) {
    throw new Error(`Invalid slot index: ${slotIndex}`);
  }

  // Derive encryption key from password
  const salt = new TextEncoder().encode('deniable-storage-slot-key-v1');
  const key = await generateEncryptionKeyFromSeed(password, salt);

  // Serialize address to JSON then bytes
  const addressJson = JSON.stringify(address);
  const plaintext = new TextEncoder().encode(addressJson);

  // Generate unique nonce
  const nonce = await generateNonce();

  // Encrypt with AEAD (no additional authenticated data)
  const ciphertext = await encryptAead(key, nonce, plaintext, new Uint8Array());

  // Pack into slot: [nonce(16 bytes)][ciphertext]
  const slotData = new Uint8Array(SLOT_SIZE);
  const nonceBytes = nonce.to_bytes();

  // Write nonce (16 bytes)
  slotData.set(nonceBytes, 0);

  // Write ciphertext (up to 16 bytes remaining)
  const maxCiphertextSize = SLOT_SIZE - 16;
  if (ciphertext.length > maxCiphertextSize) {
    throw new Error(
      `Ciphertext too large for slot: ${ciphertext.length} > ${maxCiphertextSize}`,
    );
  }
  slotData.set(ciphertext.slice(0, maxCiphertextSize), 16);

  // Write to blob at slot offset
  const slotOffset = slotIndex * SLOT_SIZE;
  blob.set(slotData, slotOffset);
}

/**
 * Reads a session address from a specific slot using AEAD decryption
 *
 * @param blob - The addressing blob to read from
 * @param slotIndex - The slot index [0..65535]
 * @param password - Password to derive decryption key
 * @returns The decrypted session address, or null if decryption fails
 *
 * @example
 * ```typescript
 * const address = await readSlot(blob, 42391, 'my-password');
 * if (address) {
 *   console.log('Found session at offset:', address.offset);
 * }
 * ```
 */
export async function readSlot(
  blob: Uint8Array,
  slotIndex: number,
  password: string,
): Promise<SessionAddress | null> {
  const {
    generateEncryptionKeyFromSeed,
    decryptAead,
  } = await import('../../../wasm/encryption');
  const { Nonce } = await import('../../../wasm/encryption');

  // Validate slot index
  if (slotIndex < 0 || slotIndex >= SLOT_COUNT) {
    return null;
  }

  // Read slot data
  const slotOffset = slotIndex * SLOT_SIZE;
  const slotData = blob.slice(slotOffset, slotOffset + SLOT_SIZE);

  // Extract nonce (first 16 bytes)
  const nonceBytes = slotData.slice(0, 16);
  const nonce = Nonce.from_bytes(nonceBytes);

  // Extract ciphertext (remaining bytes)
  const ciphertext = slotData.slice(16);

  // Derive decryption key from password
  const salt = new TextEncoder().encode('deniable-storage-slot-key-v1');
  const key = await generateEncryptionKeyFromSeed(password, salt);

  // Decrypt with AEAD
  const plaintext = await decryptAead(key, nonce, ciphertext, new Uint8Array());

  if (!plaintext) {
    // Decryption failed (wrong password or corrupted data)
    return null;
  }

  // Deserialize address from JSON
  try {
    const addressJson = new TextDecoder().decode(plaintext);
    const address = JSON.parse(addressJson) as SessionAddress;
    return address;
  } catch {
    // Invalid JSON
    return null;
  }
}

/**
 * Reads session address by scanning all 46 password-derived slots
 *
 * This function is timing-safe: it always scans all 46 slots even if
 * a valid address is found early. This prevents timing attacks that
 * could reveal slot locations.
 *
 * @param blob - The addressing blob to read from
 * @param password - Password to derive slot indices and decryption key
 * @returns The session address, or null if not found
 *
 * @example
 * ```typescript
 * const address = await readSlots(blob, 'my-password');
 * if (address) {
 *   console.log('Session found at offset:', address.offset);
 * } else {
 *   console.log('No session found (or wrong password)');
 * }
 * ```
 */
export async function readSlots(
  blob: Uint8Array,
  password: string,
): Promise<SessionAddress | null> {
  // Derive the 46 slot indices from password
  const indices = await deriveSlotIndices(password);

  // Timing-safe: scan ALL 46 slots, don't early return
  let foundAddress: SessionAddress | null = null;

  for (const slotIndex of indices) {
    const address = await readSlot(blob, slotIndex, password);

    // Store first valid address found, but continue scanning
    if (address && !foundAddress) {
      foundAddress = address;
    }
  }

  return foundAddress;
}

/**
 * Writes session address to all 46 password-derived slots
 *
 * Writes the same session address to all 46 slots for redundancy.
 * This ensures the session can be found even if some slots are
 * corrupted or overwritten by collisions.
 *
 * @param blob - The addressing blob to write to
 * @param password - Password to derive slot indices and encryption key
 * @param address - The session address to write
 *
 * @example
 * ```typescript
 * const blob = createAddressingBlob();
 * const address = {
 *   offset: 2097152,
 *   blockSize: 35000000,
 *   createdAt: Date.now(),
 *   updatedAt: Date.now(),
 *   salt: crypto.getRandomValues(new Uint8Array(16))
 * };
 * await writeSessionAddress(blob, 'my-password', address);
 * ```
 */
export async function writeSessionAddress(
  blob: Uint8Array,
  password: string,
  address: SessionAddress,
): Promise<void> {
  // Derive the 46 slot indices from password
  const indices = await deriveSlotIndices(password);

  // Write to all 46 slots
  for (const slotIndex of indices) {
    await writeSlot(blob, slotIndex, address, password);
  }
}
