/**
 * Allocation Table - Maps logical addresses to physical blocks
 *
 * The allocation table is stored in the root block and tracks all data blocks
 * for a session. Each entry maps a logical byte offset to a physical block
 * location in the data blob.
 *
 * Entry format: 56 bytes
 * - offset (8 bytes): physical location in data blob
 * - length (4 bytes): actual data length in block
 * - logicalAddress (8 bytes): logical byte offset in session
 * - blockSize (4 bytes): total block size (including headers)
 * - blockId (32 bytes): unique ID for key derivation
 *
 * A 2 MB root block can hold ~37,000 entries, supporting sessions up to ~1.3 TB
 * (at 35 MB average block size).
 *
 * @module core/AllocationTable
 */

import type { DataBlock } from '../types';
import type { EncryptionKey } from '../../../wasm/encryption';

/**
 * Single entry in the allocation table
 */
export interface AllocationEntry {
  /** Physical byte offset in data blob where block starts */
  offset: number;

  /** Actual data length stored in this block (≤ blockSize) */
  length: number;

  /** Logical byte offset in the session data */
  logicalAddress: number;

  /** Total block size including headers and padding */
  blockSize: number;

  /** Unique 32-byte identifier for block key derivation */
  blockId: Uint8Array;
}

/**
 * Root block structure containing the allocation table
 */
export interface RootBlock {
  /** Format version (currently 1) */
  version: number;

  /** Number of entries in the allocation table */
  entryCount: number;

  /** Total logical data size across all blocks */
  totalDataSize: number;

  /** Array of allocation entries, sorted by logicalAddress */
  entries: AllocationEntry[];
}

/**
 * Constants for allocation table
 */
export const ROOT_BLOCK_VERSION = 1;
export const ALLOCATION_ENTRY_SIZE = 56; // bytes
export const ROOT_BLOCK_HEADER_SIZE = 16; // version(4) + entryCount(4) + totalDataSize(8)

/**
 * Creates an empty root block
 *
 * @returns New root block with no entries
 *
 * @example
 * ```typescript
 * const rootBlock = createRootBlock();
 * console.log(rootBlock.entryCount); // 0
 * ```
 */
export function createRootBlock(): RootBlock {
  return {
    version: ROOT_BLOCK_VERSION,
    entryCount: 0,
    totalDataSize: 0,
    entries: [],
  };
}

/**
 * Serializes a root block to bytes
 *
 * Format:
 * [version: 4][entryCount: 4][totalDataSize: 8][entries...]
 *
 * Each entry: [offset: 8][length: 4][logicalAddress: 8][blockSize: 4][blockId: 32]
 *
 * @param rootBlock - Root block to serialize
 * @returns Serialized bytes
 *
 * @example
 * ```typescript
 * const bytes = serializeRootBlock(rootBlock);
 * console.log(`Root block size: ${bytes.length} bytes`);
 * ```
 */
export function serializeRootBlock(rootBlock: RootBlock): Uint8Array {
  const totalSize =
    ROOT_BLOCK_HEADER_SIZE + rootBlock.entries.length * ALLOCATION_ENTRY_SIZE;
  const buffer = new Uint8Array(totalSize);
  const view = new DataView(buffer.buffer);

  let offset = 0;

  // Write header
  view.setUint32(offset, rootBlock.version, false); // big-endian
  offset += 4;
  view.setUint32(offset, rootBlock.entryCount, false);
  offset += 4;
  // Write totalDataSize as 64-bit (split into two 32-bit values)
  const high = Math.floor(rootBlock.totalDataSize / 0x100000000);
  const low = rootBlock.totalDataSize >>> 0;
  view.setUint32(offset, high, false);
  offset += 4;
  view.setUint32(offset, low, false);
  offset += 4;

  // Write entries
  for (const entry of rootBlock.entries) {
    // offset (8 bytes)
    const offsetHigh = Math.floor(entry.offset / 0x100000000);
    const offsetLow = entry.offset >>> 0;
    view.setUint32(offset, offsetHigh, false);
    offset += 4;
    view.setUint32(offset, offsetLow, false);
    offset += 4;

    // length (4 bytes)
    view.setUint32(offset, entry.length, false);
    offset += 4;

    // logicalAddress (8 bytes)
    const addrHigh = Math.floor(entry.logicalAddress / 0x100000000);
    const addrLow = entry.logicalAddress >>> 0;
    view.setUint32(offset, addrHigh, false);
    offset += 4;
    view.setUint32(offset, addrLow, false);
    offset += 4;

    // blockSize (4 bytes)
    view.setUint32(offset, entry.blockSize, false);
    offset += 4;

    // blockId (32 bytes)
    buffer.set(entry.blockId, offset);
    offset += 32;
  }

  return buffer;
}

/**
 * Deserializes bytes to a root block
 *
 * @param bytes - Serialized root block bytes
 * @returns Parsed root block, or null if invalid
 *
 * @example
 * ```typescript
 * const rootBlock = deserializeRootBlock(bytes);
 * if (rootBlock) {
 *   console.log(`Loaded ${rootBlock.entryCount} entries`);
 * }
 * ```
 */
export function deserializeRootBlock(bytes: Uint8Array): RootBlock | null {
  if (bytes.length < ROOT_BLOCK_HEADER_SIZE) {
    return null;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;

  // Read header
  const version = view.getUint32(offset, false);
  offset += 4;

  if (version !== ROOT_BLOCK_VERSION) {
    return null; // Unsupported version
  }

  const entryCount = view.getUint32(offset, false);
  offset += 4;

  const totalDataSizeHigh = view.getUint32(offset, false);
  offset += 4;
  const totalDataSizeLow = view.getUint32(offset, false);
  offset += 4;
  const totalDataSize = totalDataSizeHigh * 0x100000000 + totalDataSizeLow;

  // Validate size
  const expectedSize =
    ROOT_BLOCK_HEADER_SIZE + entryCount * ALLOCATION_ENTRY_SIZE;
  if (bytes.length < expectedSize) {
    return null;
  }

  // Read entries
  const entries: AllocationEntry[] = [];
  for (let i = 0; i < entryCount; i++) {
    const entryOffsetHigh = view.getUint32(offset, false);
    offset += 4;
    const entryOffsetLow = view.getUint32(offset, false);
    offset += 4;
    const entryOffset = entryOffsetHigh * 0x100000000 + entryOffsetLow;

    const length = view.getUint32(offset, false);
    offset += 4;

    const logicalAddrHigh = view.getUint32(offset, false);
    offset += 4;
    const logicalAddrLow = view.getUint32(offset, false);
    offset += 4;
    const logicalAddress = logicalAddrHigh * 0x100000000 + logicalAddrLow;

    const blockSize = view.getUint32(offset, false);
    offset += 4;

    const blockId = bytes.slice(offset, offset + 32);
    offset += 32;

    entries.push({
      offset: entryOffset,
      length,
      logicalAddress,
      blockSize,
      blockId,
    });
  }

  return {
    version,
    entryCount,
    totalDataSize,
    entries,
  };
}

/**
 * Adds an entry to the allocation table
 *
 * Entries are kept sorted by logicalAddress for efficient range queries.
 *
 * @param rootBlock - Root block to modify
 * @param entry - Entry to add
 *
 * @example
 * ```typescript
 * const entry: AllocationEntry = {
 *   offset: 1024,
 *   length: 1000,
 *   logicalAddress: 0,
 *   blockSize: 2048,
 *   blockId: crypto.getRandomValues(new Uint8Array(32))
 * };
 * addAllocationEntry(rootBlock, entry);
 * ```
 */
export function addAllocationEntry(
  rootBlock: RootBlock,
  entry: AllocationEntry
): void {
  // Find insertion point to keep sorted by logicalAddress
  let insertIndex = rootBlock.entries.length;
  for (let i = 0; i < rootBlock.entries.length; i++) {
    if (entry.logicalAddress < rootBlock.entries[i].logicalAddress) {
      insertIndex = i;
      break;
    }
  }

  // Insert entry
  rootBlock.entries.splice(insertIndex, 0, entry);
  rootBlock.entryCount = rootBlock.entries.length;

  // Update total data size
  // Assumes non-overlapping entries
  rootBlock.totalDataSize = Math.max(
    rootBlock.totalDataSize,
    entry.logicalAddress + entry.length
  );
}

/**
 * Finds an allocation entry by logical address
 *
 * Returns the entry that contains the given logical address.
 *
 * @param rootBlock - Root block to search
 * @param logicalAddress - Logical byte offset to find
 * @returns Matching entry, or null if not found
 *
 * @example
 * ```typescript
 * const entry = findEntryByAddress(rootBlock, 5000);
 * if (entry) {
 *   console.log(`Found block at offset ${entry.offset}`);
 * }
 * ```
 */
export function findEntryByAddress(
  rootBlock: RootBlock,
  logicalAddress: number
): AllocationEntry | null {
  // Binary search since entries are sorted
  let left = 0;
  let right = rootBlock.entries.length - 1;

  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    const entry = rootBlock.entries[mid];

    const entryStart = entry.logicalAddress;
    const entryEnd = entry.logicalAddress + entry.length;

    if (logicalAddress >= entryStart && logicalAddress < entryEnd) {
      return entry;
    } else if (logicalAddress < entryStart) {
      right = mid - 1;
    } else {
      left = mid + 1;
    }
  }

  return null;
}

/**
 * Gets all allocation entries that overlap a logical address range
 *
 * @param rootBlock - Root block to search
 * @param startAddress - Start of logical address range
 * @param length - Length of range
 * @returns Array of overlapping entries, sorted by logicalAddress
 *
 * @example
 * ```typescript
 * const entries = getEntriesInRange(rootBlock, 1000, 5000);
 * console.log(`Found ${entries.length} blocks spanning the range`);
 * ```
 */
export function getEntriesInRange(
  rootBlock: RootBlock,
  startAddress: number,
  length: number
): AllocationEntry[] {
  const endAddress = startAddress + length;
  const result: AllocationEntry[] = [];

  for (const entry of rootBlock.entries) {
    const entryStart = entry.logicalAddress;
    const entryEnd = entry.logicalAddress + entry.length;

    // Check for overlap
    if (entryStart < endAddress && entryEnd > startAddress) {
      result.push(entry);
    }

    // Since entries are sorted, we can stop once we pass the range
    if (entryStart >= endAddress) {
      break;
    }
  }

  return result;
}

/**
 * Calculates the serialized size of a root block
 *
 * @param rootBlock - Root block to measure
 * @returns Size in bytes
 *
 * @example
 * ```typescript
 * const size = calculateRootBlockSize(rootBlock);
 * console.log(`Root block will be ${size} bytes`);
 * ```
 */
export function calculateRootBlockSize(rootBlock: RootBlock): number {
  return (
    ROOT_BLOCK_HEADER_SIZE + rootBlock.entries.length * ALLOCATION_ENTRY_SIZE
  );
}

/**
 * Validates a root block structure
 *
 * @param rootBlock - Root block to validate
 * @returns Validation result
 *
 * @example
 * ```typescript
 * const validation = validateRootBlock(rootBlock);
 * if (!validation.valid) {
 *   console.error(validation.error);
 * }
 * ```
 */
export function validateRootBlock(rootBlock: RootBlock): {
  valid: boolean;
  error?: string;
} {
  if (rootBlock.version !== ROOT_BLOCK_VERSION) {
    return { valid: false, error: `Unsupported version: ${rootBlock.version}` };
  }

  if (rootBlock.entryCount !== rootBlock.entries.length) {
    return {
      valid: false,
      error: `Entry count mismatch: ${rootBlock.entryCount} !== ${rootBlock.entries.length}`,
    };
  }

  // Validate entries are sorted
  for (let i = 1; i < rootBlock.entries.length; i++) {
    if (
      rootBlock.entries[i].logicalAddress <
      rootBlock.entries[i - 1].logicalAddress
    ) {
      return {
        valid: false,
        error: `Entries not sorted at index ${i}`,
      };
    }
  }

  // Validate no overlapping logical addresses
  for (let i = 1; i < rootBlock.entries.length; i++) {
    const prev = rootBlock.entries[i - 1];
    const curr = rootBlock.entries[i];
    const prevEnd = prev.logicalAddress + prev.length;

    if (curr.logicalAddress < prevEnd) {
      return {
        valid: false,
        error: `Overlapping entries at index ${i}`,
      };
    }
  }

  // Validate block IDs are 32 bytes
  for (let i = 0; i < rootBlock.entries.length; i++) {
    if (rootBlock.entries[i].blockId.length !== 32) {
      return {
        valid: false,
        error: `Invalid blockId length at index ${i}: ${rootBlock.entries[i].blockId.length}`,
      };
    }
  }

  return { valid: true };
}

/**
 * Encrypts a root block with session key
 *
 * The root block is serialized and then encrypted using AEAD encryption
 * with the session key. This protects the allocation table from inspection.
 *
 * @param rootBlock - Root block to encrypt
 * @param sessionKey - Session encryption key (derived from password)
 * @returns Encrypted data block containing the root block
 *
 * @example
 * ```typescript
 * const encryptedBlock = await encryptRootBlock(rootBlock, sessionKey);
 * console.log(`Encrypted root block size: ${encryptedBlock.size} bytes`);
 * ```
 */
export async function encryptRootBlock(
  rootBlock: RootBlock,
  sessionKey: EncryptionKey
): Promise<DataBlock> {
  const { generateNonce, encryptAead } =
    await import('../../../wasm/encryption');

  // Serialize root block
  const plaintext = serializeRootBlock(rootBlock);

  // Generate unique nonce
  const nonce = await generateNonce();

  // Encrypt with AEAD using session key
  const ciphertext = await encryptAead(
    sessionKey,
    nonce,
    plaintext,
    new Uint8Array()
  );

  // Calculate total block size: header + nonce + ciphertext
  const BLOCK_HEADER_SIZE = 4;
  const NONCE_SIZE = 16;
  const totalSize = BLOCK_HEADER_SIZE + NONCE_SIZE + ciphertext.length;

  return {
    size: totalSize,
    nonce: nonce.to_bytes(),
    ciphertext,
  };
}

/**
 * Decrypts and parses a root block
 *
 * Reads an encrypted root block from the data blob and decrypts it
 * using the session key.
 *
 * @param dataBlob - The data blob containing the encrypted root block
 * @param offset - Byte offset where the root block starts
 * @param sessionKey - Session decryption key
 * @returns Decrypted root block, or null if decryption/parsing fails
 *
 * @example
 * ```typescript
 * const rootBlock = await decryptRootBlock(dataBlob, offset, sessionKey);
 * if (rootBlock) {
 *   console.log(`Loaded ${rootBlock.entryCount} allocation entries`);
 * }
 * ```
 */
export async function decryptRootBlock(
  dataBlob: Uint8Array,
  offset: number,
  sessionKey: EncryptionKey
): Promise<RootBlock | null> {
  const { decryptAead, Nonce } = await import('../../../wasm/encryption');

  // Validate offset
  if (offset < 0 || offset >= dataBlob.length) {
    return null;
  }

  try {
    const BLOCK_HEADER_SIZE = 4;
    const NONCE_SIZE = 16;

    // Read block size (4 bytes, uint32 big-endian)
    if (offset + 4 > dataBlob.length) {
      return null;
    }
    const sizeBytes = dataBlob.slice(offset, offset + 4);
    const view = new DataView(sizeBytes.buffer);
    const blockSize = view.getUint32(0, false); // big-endian

    // Validate block size
    if (
      blockSize < BLOCK_HEADER_SIZE + NONCE_SIZE ||
      blockSize > dataBlob.length - offset
    ) {
      return null;
    }

    // Read nonce (16 bytes)
    const nonceOffset = offset + 4;
    if (nonceOffset + NONCE_SIZE > dataBlob.length) {
      return null;
    }
    const nonceBytes = dataBlob.slice(nonceOffset, nonceOffset + NONCE_SIZE);
    const nonce = Nonce.from_bytes(nonceBytes);

    // Read ciphertext
    const ciphertextOffset = nonceOffset + NONCE_SIZE;
    const ciphertextSize = blockSize - BLOCK_HEADER_SIZE - NONCE_SIZE;
    if (ciphertextOffset + ciphertextSize > dataBlob.length) {
      return null;
    }
    const ciphertext = dataBlob.slice(
      ciphertextOffset,
      ciphertextOffset + ciphertextSize
    );

    // Decrypt with AEAD using session key
    const plaintext = await decryptAead(
      sessionKey,
      nonce,
      ciphertext,
      new Uint8Array()
    );
    if (!plaintext) {
      return null;
    }

    // Deserialize root block
    const rootBlock = deserializeRootBlock(plaintext);
    if (!rootBlock) {
      return null;
    }

    // Validate structure
    const validation = validateRootBlock(rootBlock);
    if (!validation.valid) {
      return null;
    }

    return rootBlock;
  } catch {
    return null;
  }
}
