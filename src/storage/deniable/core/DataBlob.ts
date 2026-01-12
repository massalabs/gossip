/**
 * Data Blob - Stores encrypted session blocks with random padding
 *
 * The data blob is a variable-size structure containing encrypted session blocks
 * interspersed with random padding. This makes it impossible to distinguish
 * real data from padding, providing plausible deniability.
 *
 * Block sizes follow a Log-Normal distribution (2-256 MB, mean 35 MB)
 * Padding sizes follow a Pareto distribution (5-600 MB, mean 17.5 MB, α=1.25)
 *
 * @module core/DataBlob
 */

import type { DataBlock } from '../types';
import { generateBlockSize, generatePaddingSize } from './distributions';

/**
 * Block header format: [blockSize(4 bytes)][nonce(16 bytes)][ciphertext(variable)]
 */
const BLOCK_HEADER_SIZE = 4; // 4 bytes for block size (uint32)
const NONCE_SIZE = 16; // 16 bytes for AES-SIV nonce

/**
 * Creates an encrypted data block from plaintext
 *
 * Format: [blockSize(4)][nonce(16)][ciphertext]
 *
 * @param data - Plaintext data to encrypt
 * @param password - Password to derive encryption key
 * @returns Encrypted data block with metadata
 *
 * @example
 * ```typescript
 * const data = new TextEncoder().encode('secret data');
 * const block = await createDataBlock(data, 'my-password');
 * console.log(`Block size: ${block.size} bytes`);
 * ```
 */
export async function createDataBlock(
  data: Uint8Array,
  password: string,
): Promise<DataBlock> {
  const {
    generateEncryptionKeyFromSeed,
    generateNonce,
    encryptAead,
  } = await import('../../../wasm/encryption');

  // Derive encryption key from password
  const salt = new TextEncoder().encode('deniable-storage-data-key-v1');
  const key = await generateEncryptionKeyFromSeed(password, salt);

  // Generate unique nonce
  const nonce = await generateNonce();

  // Encrypt data with AEAD
  const ciphertext = await encryptAead(key, nonce, data, new Uint8Array());

  // Calculate total block size: header + nonce + ciphertext
  const totalSize = BLOCK_HEADER_SIZE + NONCE_SIZE + ciphertext.length;

  return {
    size: totalSize,
    nonce: nonce.to_bytes(),
    ciphertext,
  };
}

/**
 * Generates random padding bytes
 *
 * Padding is cryptographically indistinguishable from encrypted data.
 *
 * @param size - Size of padding in bytes
 * @returns Random padding bytes
 *
 * @example
 * ```typescript
 * const padding = generatePadding(5 * 1024 * 1024); // 5 MB
 * ```
 */
export function generatePadding(size: number): Uint8Array {
  const padding = new Uint8Array(size);
  crypto.getRandomValues(padding);
  return padding;
}

/**
 * Assembles a data blob from multiple blocks and padding
 *
 * Structure: [block1][padding1][block2][padding2]...[blockN][paddingN]
 *
 * Each block is preceded by random padding following Pareto distribution.
 * This creates plausible deniability by making it impossible to distinguish
 * between data blocks and padding.
 *
 * @param blocks - Array of encrypted data blocks
 * @returns Complete data blob with blocks interspersed with padding
 *
 * @example
 * ```typescript
 * const block1 = await createDataBlock(data1, 'pass1');
 * const block2 = await createDataBlock(data2, 'pass2');
 * const blob = assembleDataBlob([block1, block2]);
 * ```
 */
export function assembleDataBlob(blocks: DataBlock[]): Uint8Array {
  if (blocks.length === 0) {
    // Return empty blob with some initial padding
    const initialPaddingSize = generatePaddingSize();
    return generatePadding(initialPaddingSize);
  }

  // Calculate total size: sum of (padding + block) for each block
  let totalSize = 0;
  const paddingSizes: number[] = [];

  for (let i = 0; i < blocks.length; i++) {
    // Generate padding size for this block
    const paddingSize = generatePaddingSize();
    paddingSizes.push(paddingSize);
    totalSize += paddingSize + blocks[i].size;
  }

  // Allocate blob
  const blob = new Uint8Array(totalSize);
  let offset = 0;

  // Write [padding][block] for each block
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const paddingSize = paddingSizes[i];

    // Write padding
    const padding = generatePadding(paddingSize);
    blob.set(padding, offset);
    offset += paddingSize;

    // Write block: [blockSize(4)][nonce(16)][ciphertext]
    // Write block size (uint32 big-endian)
    const sizeBytes = new Uint8Array(4);
    const view = new DataView(sizeBytes.buffer);
    view.setUint32(0, block.size, false); // big-endian
    blob.set(sizeBytes, offset);
    offset += 4;

    // Write nonce
    blob.set(block.nonce, offset);
    offset += NONCE_SIZE;

    // Write ciphertext
    blob.set(block.ciphertext, offset);
    offset += block.ciphertext.length;
  }

  return blob;
}

/**
 * Parses a data blob to extract a specific block at given offset
 *
 * @param blob - The data blob to parse
 * @param offset - Byte offset where the block starts
 * @param password - Password to decrypt the block
 * @returns Decrypted data, or null if decryption fails
 *
 * @example
 * ```typescript
 * const data = await parseDataBlob(blob, 5242880, 'my-password');
 * if (data) {
 *   console.log('Decrypted:', new TextDecoder().decode(data));
 * }
 * ```
 */
export async function parseDataBlob(
  blob: Uint8Array,
  offset: number,
  password: string,
): Promise<Uint8Array | null> {
  const {
    generateEncryptionKeyFromSeed,
    decryptAead,
    Nonce,
  } = await import('../../../wasm/encryption');

  // Validate offset
  if (offset < 0 || offset >= blob.length) {
    return null;
  }

  try {
    // Read block size (4 bytes, uint32 big-endian)
    if (offset + 4 > blob.length) {
      return null;
    }
    const sizeBytes = blob.slice(offset, offset + 4);
    const view = new DataView(sizeBytes.buffer);
    const blockSize = view.getUint32(0, false); // big-endian

    // Validate block size
    if (blockSize < BLOCK_HEADER_SIZE + NONCE_SIZE || blockSize > blob.length - offset) {
      return null;
    }

    // Read nonce (16 bytes)
    const nonceOffset = offset + 4;
    if (nonceOffset + NONCE_SIZE > blob.length) {
      return null;
    }
    const nonceBytes = blob.slice(nonceOffset, nonceOffset + NONCE_SIZE);
    const nonce = Nonce.from_bytes(nonceBytes);

    // Read ciphertext
    const ciphertextOffset = nonceOffset + NONCE_SIZE;
    const ciphertextSize = blockSize - BLOCK_HEADER_SIZE - NONCE_SIZE;
    if (ciphertextOffset + ciphertextSize > blob.length) {
      return null;
    }
    const ciphertext = blob.slice(ciphertextOffset, ciphertextOffset + ciphertextSize);

    // Derive decryption key
    const salt = new TextEncoder().encode('deniable-storage-data-key-v1');
    const key = await generateEncryptionKeyFromSeed(password, salt);

    // Decrypt with AEAD
    const plaintext = await decryptAead(key, nonce, ciphertext, new Uint8Array());

    return plaintext || null;
  } catch {
    return null;
  }
}

/**
 * Appends a new block to an existing data blob
 *
 * @param blob - Existing data blob
 * @param block - New block to append
 * @returns New blob with block appended
 */
export function appendBlock(blob: Uint8Array, block: DataBlock): Uint8Array {
  const paddingSize = generatePaddingSize();
  const newSize = blob.length + paddingSize + block.size;
  const newBlob = new Uint8Array(newSize);

  // Copy existing blob
  newBlob.set(blob, 0);
  let offset = blob.length;

  // Add padding
  const padding = generatePadding(paddingSize);
  newBlob.set(padding, offset);
  offset += paddingSize;

  // Write block
  const sizeBytes = new Uint8Array(4);
  const view = new DataView(sizeBytes.buffer);
  view.setUint32(0, block.size, false);
  newBlob.set(sizeBytes, offset);
  offset += 4;

  newBlob.set(block.nonce, offset);
  offset += NONCE_SIZE;

  newBlob.set(block.ciphertext, offset);

  return newBlob;
}
