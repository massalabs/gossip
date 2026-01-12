/**
 * Public API types for Deniable Storage
 *
 * This module defines the public interface for the plausibly deniable
 * multi-session encrypted storage system.
 *
 * @module types
 */

/**
 * Configuration for initializing deniable storage
 */
export interface DeniableStorageConfig {
  /**
   * Storage adapter for platform-specific persistence
   */
  adapter: StorageAdapter;

  /**
   * Optional: Custom sizes for addressing blob (default: 2MB)
   */
  addressingBlobSize?: number;

  /**
   * Optional: Enable timing-safe operations (default: true)
   */
  timingSafe?: boolean;
}

/**
 * Platform-specific storage adapter interface
 * Implement this for different platforms (Web, Capacitor, Node, etc.)
 */
export interface StorageAdapter {
  /**
   * Initialize storage (create files/tables if needed)
   */
  initialize(): Promise<void>;

  /**
   * Read the addressing blob (2MB fixed size)
   */
  readAddressingBlob(): Promise<Uint8Array>;

  /**
   * Write the addressing blob
   */
  writeAddressingBlob(data: Uint8Array): Promise<void>;

  /**
   * Read the data blob (variable size)
   */
  readDataBlob(): Promise<Uint8Array>;

  /**
   * Write the data blob
   */
  writeDataBlob(data: Uint8Array): Promise<void>;

  /**
   * Get current size of data blob
   */
  getDataBlobSize(): Promise<number>;

  /**
   * Append data to the data blob (optimization)
   */
  appendToDataBlob(data: Uint8Array): Promise<void>;

  /**
   * Securely wipe storage (overwrite with random data)
   */
  secureWipe(): Promise<void>;
}

/**
 * Result of a session unlock operation
 */
export interface UnlockResult {
  /**
   * Session data (decrypted)
   */
  data: Uint8Array;

  /**
   * Timestamp when created
   */
  createdAt: number;

  /**
   * Timestamp when last updated
   */
  updatedAt: number;
}

/**
 * Internal: Address of a session in the data blob (multi-block architecture)
 */
export interface SessionAddress {
  /**
   * Byte offset of the root block in data blob
   */
  rootBlockOffset: number;

  /**
   * Size of the encrypted root block
   */
  rootBlockSize: number;

  /**
   * Timestamp when created
   */
  createdAt: number;

  /**
   * Timestamp when last updated
   */
  updatedAt: number;

  /**
   * KDF salt for session key derivation
   */
  sessionKeyDerivationSalt: Uint8Array;
}

/**
 * Internal: Encrypted slot in the addressing blob
 */
export interface EncryptedSlot {
  /**
   * AEAD nonce
   */
  nonce: Uint8Array;

  /**
   * Ciphertext (encrypted SessionAddress)
   */
  ciphertext: Uint8Array;
}

/**
 * Internal: Encrypted data block
 */
export interface DataBlock {
  /**
   * Size of this block (4 bytes header)
   */
  size: number;

  /**
   * AEAD nonce
   */
  nonce: Uint8Array;

  /**
   * Encrypted data
   */
  ciphertext: Uint8Array;
}

/**
 * Statistics about the storage (for debugging/analysis)
 */
export interface StorageStats {
  /**
   * Total size of addressing blob
   */
  addressingBlobSize: number;

  /**
   * Total size of data blob
   */
  dataBlobSize: number;

  /**
   * Number of sessions (estimated, for testing only)
   */
  estimatedSessions?: number;

  /**
   * Storage overhead ratio (padding / total)
   */
  overheadRatio?: number;
}

/**
 * Error types
 */
export enum DeniableStorageError {
  INVALID_PASSWORD = 'INVALID_PASSWORD',
  SESSION_NOT_FOUND = 'SESSION_NOT_FOUND',
  STORAGE_CORRUPTED = 'STORAGE_CORRUPTED',
  ADAPTER_ERROR = 'ADAPTER_ERROR',
  CRYPTO_ERROR = 'CRYPTO_ERROR',
}

export class DeniableStorageException extends Error {
  constructor(
    public code: DeniableStorageError,
    message: string,
    public cause?: Error
  ) {
    super(message);
    this.name = 'DeniableStorageException';
  }
}
