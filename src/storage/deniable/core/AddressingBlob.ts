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
 * Uses HKDF-SHA256 to derive pseudo-random bytes from the password,
 * then maps them to slot indices in [0..65535]. This ensures:
 * - Deterministic: same password always gives same indices
 * - Uniform distribution across all slots
 * - Cryptographically secure derivation
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
  // Import hkdf from @noble/hashes
  const { hkdf } = await import('@noble/hashes/hkdf');
  const { sha256 } = await import('@noble/hashes/sha256');

  // Convert password to bytes
  const passwordBytes = new TextEncoder().encode(password);

  // Use HKDF to derive enough bytes for 46 indices
  // Each index needs 2 bytes (uint16 for 0-65535 range)
  // We derive extra to handle potential collisions
  const bytesNeeded = SLOTS_PER_SESSION * 2 * 2; // 184 bytes (extra for uniqueness)
  const info = new TextEncoder().encode('deniable-storage-slot-derivation-v1');
  const salt = new Uint8Array(32); // Zero salt for simplicity

  const derivedBytes = hkdf(sha256, passwordBytes, salt, info, bytesNeeded);

  // Convert bytes to slot indices
  const indices: number[] = [];
  const seenIndices = new Set<number>();

  for (let i = 0; i < derivedBytes.length - 1 && indices.length < SLOTS_PER_SESSION; i += 2) {
    // Read 2 bytes as uint16 (big-endian)
    const index = (derivedBytes[i] << 8) | derivedBytes[i + 1];

    // Only add if not already seen (ensure uniqueness)
    if (!seenIndices.has(index)) {
      indices.push(index);
      seenIndices.add(index);
    }
  }

  // Ensure we have exactly 46 indices
  if (indices.length < SLOTS_PER_SESSION) {
    throw new Error(
      `Failed to derive enough unique slot indices (got ${indices.length}, need ${SLOTS_PER_SESSION})`,
    );
  }

  return indices.slice(0, SLOTS_PER_SESSION);
}

// TODO: Sprint 1.3 - Implement writeSlot()
// TODO: Sprint 1.4 - Implement readSlots()
// TODO: Sprint 1.5 - Implement writeSessionAddress()
