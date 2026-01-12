/**
 * Main DeniableStorage class - Public API facade
 *
 * This is the primary entry point for interacting with the deniable storage system.
 * It orchestrates the addressing blob, data blob, and crypto operations.
 *
 * @module DeniableStorage
 */

import type {
  DeniableStorageConfig,
  UnlockResult,
  StorageStats,
} from './types';

/**
 * Plausibly Deniable Multi-Session Encrypted Storage
 *
 * @example
 * ```typescript
 * const storage = new DeniableStorage({ adapter: new WebAdapter() });
 * await storage.initialize();
 * await storage.createSession('password', data);
 * const result = await storage.unlockSession('password');
 * ```
 */
export class DeniableStorage {
  private config: Required<DeniableStorageConfig>;
  private initialized = false;

  constructor(config: DeniableStorageConfig) {
    this.config = {
      addressingBlobSize: 2 * 1024 * 1024, // 2MB default
      timingSafe: true,
      ...config,
    };
  }

  /**
   * Initialize the storage system
   * Creates the addressing and data blobs if they don't exist
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    await this.config.adapter.initialize();
    this.initialized = true;

    // TODO: Sprint 1.1 - Create addressing blob if not exists
    // TODO: Sprint 2.5 - Create data blob if not exists
  }

  /**
   * Create a new session with the given password
   *
   * @param password - Password to protect this session
   * @param data - Data to store (will be encrypted)
   * @throws {DeniableStorageException} If storage is not initialized
   */
  async createSession(password: string, data: Uint8Array): Promise<void> {
    this.ensureInitialized();

    // TODO: Sprint 3.2 - Implement session creation
    // 1. Generate block size from log-normal distribution
    // 2. Encrypt data -> DataBlock
    // 3. Append to DataBlob with padding
    // 4. Write address to AddressingBlob (46 slots)

    throw new Error('Not implemented yet');
  }

  /**
   * Unlock a session with the given password
   *
   * @param password - Password to unlock the session
   * @returns Decrypted session data and metadata, or null if password is invalid
   * @throws {DeniableStorageException} If storage error occurs
   */
  async unlockSession(password: string): Promise<UnlockResult | null> {
    this.ensureInitialized();

    // TODO: Sprint 3.3 - Implement session unlock
    // 1. Read AddressingBlob -> find SessionAddress (scan all 46 slots)
    // 2. Parse DataBlob at offset
    // 3. Decrypt and return data
    // IMPORTANT: Timing-safe - same time for valid/invalid password

    throw new Error('Not implemented yet');
  }

  /**
   * Update an existing session
   *
   * @param password - Password of the session to update
   * @param newData - New data to store
   * @throws {DeniableStorageException} If session not found or storage error
   */
  async updateSession(password: string, newData: Uint8Array): Promise<void> {
    this.ensureInitialized();

    // TODO: Sprint 3.4 - Implement session update
    // 1. Unlock to find address
    // 2. If size changes: reallocate in DataBlob
    // 3. Encrypt newData -> write
    // 4. Update address if offset changed

    throw new Error('Not implemented yet');
  }

  /**
   * Delete a session (secure wipe)
   *
   * @param password - Password of the session to delete
   * @throws {DeniableStorageException} If session not found
   */
  async deleteSession(password: string): Promise<void> {
    this.ensureInitialized();

    // TODO: Sprint 3.5 - Implement session deletion
    // 1. Overwrite 46 slots in AddressingBlob with random
    // 2. Overwrite DataBlock with random
    // Note: Leaves padding intact for deniability

    throw new Error('Not implemented yet');
  }

  /**
   * Get storage statistics (for debugging/analysis)
   *
   * @returns Storage stats
   */
  async getStats(): Promise<StorageStats> {
    this.ensureInitialized();

    const dataBlobSize = await this.config.adapter.getDataBlobSize();

    return {
      addressingBlobSize: this.config.addressingBlobSize,
      dataBlobSize,
    };
  }

  /**
   * Securely wipe all storage (nuclear option)
   */
  async secureWipeAll(): Promise<void> {
    this.ensureInitialized();
    await this.config.adapter.secureWipe();
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error(
        'Storage not initialized. Call initialize() first.',
      );
    }
  }
}
