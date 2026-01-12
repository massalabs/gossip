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
    // Validate adapter
    const { validateAdapter } = require('./utils/validation');
    const validation = validateAdapter(config.adapter);
    if (!validation.valid) {
      throw new Error(`Invalid adapter: ${validation.error}`);
    }

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

    // Check if blobs exist, create if not
    try {
      await this.config.adapter.readAddressingBlob();
    } catch {
      // Addressing blob doesn't exist, create it
      const { createAddressingBlob } = await import('./core/AddressingBlob');
      const addressingBlob = createAddressingBlob();
      await this.config.adapter.writeAddressingBlob(addressingBlob);
    }

    try {
      await this.config.adapter.readDataBlob();
    } catch {
      // Data blob doesn't exist, create it with initial padding
      const { generatePaddingSize } = await import('./core/distributions');
      const { generatePadding } = await import('./core/DataBlob');
      const initialSize = generatePaddingSize();
      const dataBlob = generatePadding(initialSize);
      await this.config.adapter.writeDataBlob(dataBlob);
    }

    this.initialized = true;
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

    // Validate inputs
    const { validatePassword, validateDataSize } = await import(
      './utils/validation'
    );

    const passwordValidation = validatePassword(password);
    if (!passwordValidation.valid) {
      throw new Error(`Invalid password: ${passwordValidation.error}`);
    }

    const dataValidation = validateDataSize(data, 100 * 1024 * 1024); // 100MB max
    if (!dataValidation.valid) {
      throw new Error(`Invalid data: ${dataValidation.error}`);
    }

    // Import required functions
    const { createDataBlock, appendBlock } = await import('./core/DataBlob');
    const { writeSessionAddress } = await import('./core/AddressingBlob');

    // 1. Encrypt data into a DataBlock
    const block = await createDataBlock(data, password);

    // 2. Read current data blob and append new block with padding
    const currentDataBlob = await this.config.adapter.readDataBlob();
    const newDataBlob = appendBlock(currentDataBlob, block);

    // 3. Calculate offset where this block was written
    // Offset is: currentDataBlob.length + paddingSize + BLOCK_HEADER
    // We know the block starts after the current blob and its preceding padding
    const blockOffset = currentDataBlob.length; // Points to start of padding+block

    // 4. Create session address
    const sessionAddress = {
      offset: blockOffset,
      blockSize: block.size,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      salt: crypto.getRandomValues(new Uint8Array(16)),
    };

    // 5. Write address to addressing blob (46 slots)
    const addressingBlob = await this.config.adapter.readAddressingBlob();
    await writeSessionAddress(addressingBlob, password, sessionAddress);

    // 6. Persist both blobs
    await this.config.adapter.writeAddressingBlob(addressingBlob);
    await this.config.adapter.writeDataBlob(newDataBlob);
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

    // Validate password
    const { validatePassword } = await import('./utils/validation');
    const passwordValidation = validatePassword(password);
    if (!passwordValidation.valid) {
      throw new Error(`Invalid password: ${passwordValidation.error}`);
    }

    // Import required functions
    const { readSlots } = await import('./core/AddressingBlob');
    const { parseDataBlob } = await import('./core/DataBlob');

    // 1. Read addressing blob and find session address
    // This is timing-safe: scans all 46 slots regardless of success
    const addressingBlob = await this.config.adapter.readAddressingBlob();
    const sessionAddress = await readSlots(addressingBlob, password);

    if (!sessionAddress) {
      // No session found for this password (or wrong password)
      return null;
    }

    // 2. Read data blob and parse block at offset
    const dataBlob = await this.config.adapter.readDataBlob();

    // Need to find the actual block start within the padding+block region
    // The offset points to padding+block, we need to scan for the block header
    let blockStart = -1;
    const searchStart = sessionAddress.offset;
    const searchEnd = Math.min(searchStart + 600 * 1024 * 1024, dataBlob.length); // Max padding size

    for (let i = searchStart; i < searchEnd - 4; i++) {
      const view = new DataView(dataBlob.buffer, i, 4);
      const size = view.getUint32(0, false);

      // Check if this could be a valid block header
      if (size === sessionAddress.blockSize && size > 20 && size < 256 * 1024 * 1024) {
        blockStart = i;
        break;
      }
    }

    if (blockStart === -1) {
      // Block not found at expected offset
      return null;
    }

    // 3. Decrypt block data
    const decryptedData = await parseDataBlob(dataBlob, blockStart, password);

    if (!decryptedData) {
      // Decryption failed (wrong password or corrupted data)
      return null;
    }

    // 4. Return unlocked session
    return {
      data: decryptedData,
      createdAt: sessionAddress.createdAt,
      updatedAt: sessionAddress.updatedAt,
    };
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

    // Validate inputs
    const { validatePassword, validateDataSize } = await import(
      './utils/validation'
    );

    const passwordValidation = validatePassword(password);
    if (!passwordValidation.valid) {
      throw new Error(`Invalid password: ${passwordValidation.error}`);
    }

    const dataValidation = validateDataSize(newData, 100 * 1024 * 1024);
    if (!dataValidation.valid) {
      throw new Error(`Invalid data: ${dataValidation.error}`);
    }

    // Import required functions
    const { readSlots, writeSessionAddress } = await import('./core/AddressingBlob');
    const { createDataBlock, appendBlock } = await import('./core/DataBlob');

    // 1. Find current session address
    const addressingBlob = await this.config.adapter.readAddressingBlob();
    const currentAddress = await readSlots(addressingBlob, password);

    if (!currentAddress) {
      throw new Error('Session not found');
    }

    // 2. Create new encrypted block
    const newBlock = await createDataBlock(newData, password);

    // 3. Strategy: Always append as new block (simpler, preserves deniability)
    // Could optimize to reuse space if new size <= old size, but appending is safer
    const currentDataBlob = await this.config.adapter.readDataBlob();
    const newDataBlob = appendBlock(currentDataBlob, newBlock);

    // 4. Calculate new block offset
    const newBlockOffset = currentDataBlob.length;

    // 5. Update session address with new offset and metadata
    const updatedAddress = {
      offset: newBlockOffset,
      blockSize: newBlock.size,
      createdAt: currentAddress.createdAt,
      updatedAt: Date.now(),
      salt: currentAddress.salt,
    };

    // 6. Write updated address to addressing blob (overwrites 46 slots)
    await writeSessionAddress(addressingBlob, password, updatedAddress);

    // 7. Persist both blobs
    await this.config.adapter.writeAddressingBlob(addressingBlob);
    await this.config.adapter.writeDataBlob(newDataBlob);

    // Note: Old block remains in data blob as "padding" for plausible deniability
  }

  /**
   * Delete a session (secure wipe)
   *
   * @param password - Password of the session to delete
   * @throws {DeniableStorageException} If session not found
   */
  async deleteSession(password: string): Promise<void> {
    this.ensureInitialized();

    // Validate password
    const { validatePassword } = await import('./utils/validation');
    const passwordValidation = validatePassword(password);
    if (!passwordValidation.valid) {
      throw new Error(`Invalid password: ${passwordValidation.error}`);
    }

    // Import required functions
    const { readSlots, deriveSlotIndices, SLOT_SIZE } = await import('./core/AddressingBlob');

    // 1. Find session to verify it exists
    const addressingBlob = await this.config.adapter.readAddressingBlob();
    const sessionAddress = await readSlots(addressingBlob, password);

    if (!sessionAddress) {
      throw new Error('Session not found');
    }

    // 2. Overwrite all 46 addressing slots with random data
    // This makes the session unrecoverable
    const slotIndices = await deriveSlotIndices(password);

    for (const slotIndex of slotIndices) {
      const slotOffset = slotIndex * SLOT_SIZE;
      const randomData = new Uint8Array(SLOT_SIZE);
      crypto.getRandomValues(randomData);
      addressingBlob.set(randomData, slotOffset);
    }

    // 3. Overwrite the data block with random data
    const dataBlob = await this.config.adapter.readDataBlob();

    // Find the actual block start (same logic as unlockSession)
    let blockStart = -1;
    const searchStart = sessionAddress.offset;
    const searchEnd = Math.min(searchStart + 600 * 1024 * 1024, dataBlob.length);

    for (let i = searchStart; i < searchEnd - 4; i++) {
      const view = new DataView(dataBlob.buffer, i, 4);
      const size = view.getUint32(0, false);

      if (size === sessionAddress.blockSize && size > 20 && size < 256 * 1024 * 1024) {
        blockStart = i;
        break;
      }
    }

    if (blockStart !== -1) {
      // Overwrite the entire block with random data
      const blockEnd = blockStart + sessionAddress.blockSize;
      const randomBlock = new Uint8Array(sessionAddress.blockSize);
      crypto.getRandomValues(randomBlock);
      dataBlob.set(randomBlock, blockStart);
    }

    // 4. Persist updated blobs
    await this.config.adapter.writeAddressingBlob(addressingBlob);
    await this.config.adapter.writeDataBlob(dataBlob);

    // Note: Padding remains intact, making deletion indistinguishable from random data
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
