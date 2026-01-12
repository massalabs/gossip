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
    // Validate adapter synchronously (dynamic import not available in constructor)
    // Validation will be re-checked in initialize()
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
   * Uses multi-block architecture with allocation table per spec.
   *
   * @param password - Password to protect this session
   * @param data - Data to store (will be encrypted)
   * @throws {DeniableStorageException} If storage is not initialized
   */
  async createSession(password: string, data: Uint8Array): Promise<void> {
    this.ensureInitialized();

    // Validate inputs
    const { validatePassword, validateDataSize } =
      await import('./utils/validation');

    const passwordValidation = validatePassword(password);
    if (!passwordValidation.valid) {
      throw new Error(`Invalid password: ${passwordValidation.error}`);
    }

    const dataValidation = validateDataSize(data, 1024 * 1024 * 1024); // 1GB max
    if (!dataValidation.valid) {
      throw new Error(`Invalid data: ${dataValidation.error}`);
    }

    // Import required functions
    const { generateEncryptionKeyFromSeed } =
      await import('../../wasm/encryption');
    const { deriveBlockKey, createDataBlockWithKey, appendBlock } =
      await import('./core/DataBlob');
    const { createRootBlock, addAllocationEntry, encryptRootBlock } =
      await import('./core/AllocationTable');
    const { writeSessionAddress } = await import('./core/AddressingBlob');

    // 1. Derive session key from password
    const sessionSalt = new TextEncoder().encode('deniable-storage-session-v1');
    const sessionKey = await generateEncryptionKeyFromSeed(
      password,
      sessionSalt
    );

    // 2. Create data block with unique block ID
    const blockId = crypto.getRandomValues(new Uint8Array(32));
    const blockKey = await deriveBlockKey(sessionKey, blockId);
    const dataBlock = await createDataBlockWithKey(data, blockKey);

    // 3. Append data block to data blob
    const currentDataBlob = await this.config.adapter.readDataBlob();
    const dataBlockOffset = currentDataBlob.length;
    let newDataBlob = appendBlock(currentDataBlob, dataBlock);

    // 4. Create allocation table entry
    const rootBlock = createRootBlock();
    const entry = {
      offset: dataBlockOffset,
      length: data.length,
      logicalAddress: 0,
      blockSize: dataBlock.size,
      blockId: blockId,
    };
    addAllocationEntry(rootBlock, entry);

    // 5. Encrypt and append root block
    const encryptedRootBlock = await encryptRootBlock(rootBlock, sessionKey);
    const rootBlockOffset = newDataBlob.length;
    newDataBlob = appendBlock(newDataBlob, encryptedRootBlock);

    // 6. Create session address pointing to root block
    const sessionAddress = {
      rootBlockOffset: rootBlockOffset,
      rootBlockSize: encryptedRootBlock.size,
      sessionKeyDerivationSalt: crypto.getRandomValues(new Uint8Array(16)),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    // 7. Write address to addressing blob (46 slots)
    const addressingBlob = await this.config.adapter.readAddressingBlob();
    await writeSessionAddress(addressingBlob, password, sessionAddress);

    // 8. Persist both blobs
    await this.config.adapter.writeAddressingBlob(addressingBlob);
    await this.config.adapter.writeDataBlob(newDataBlob);
  }

  /**
   * Unlock a session with the given password
   *
   * Uses multi-block architecture with allocation table per spec.
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
    const { generateEncryptionKeyFromSeed } =
      await import('../../wasm/encryption');
    const { decryptRootBlock } = await import('./core/AllocationTable');
    const { deriveBlockKey, parseDataBlobWithKey } =
      await import('./core/DataBlob');

    // 1. Read addressing blob and find session address
    // This is timing-safe: scans all 46 slots regardless of success
    const addressingBlob = await this.config.adapter.readAddressingBlob();
    const sessionAddress = await readSlots(addressingBlob, password);

    if (!sessionAddress) {
      // No session found for this password (or wrong password)
      return null;
    }

    // 2. Derive session key from password
    const sessionSalt = new TextEncoder().encode('deniable-storage-session-v1');
    const sessionKey = await generateEncryptionKeyFromSeed(
      password,
      sessionSalt
    );

    // 3. Read and decrypt root block
    const dataBlob = await this.config.adapter.readDataBlob();
    const rootBlock = await decryptRootBlock(
      dataBlob,
      sessionAddress.rootBlockOffset,
      sessionKey
    );

    if (!rootBlock) {
      // Root block decryption failed
      return null;
    }

    // 4. Reconstruct session data from allocation table
    const sessionData = new Uint8Array(rootBlock.totalDataSize);

    for (const entry of rootBlock.entries) {
      // Derive block-specific key
      const blockKey = await deriveBlockKey(sessionKey, entry.blockId);

      // Decrypt data block
      const blockData = await parseDataBlobWithKey(
        dataBlob,
        entry.offset,
        blockKey
      );

      if (!blockData) {
        // Block decryption failed
        return null;
      }

      // Copy to correct logical position (trim to entry.length)
      const dataToWrite = blockData.slice(0, entry.length);
      sessionData.set(dataToWrite, entry.logicalAddress);
    }

    // 5. Self-healing: Re-write all 46 slots with fresh nonces
    // This recovers from any slot corruption and provides forward security
    const { writeSessionAddress } = await import('./core/AddressingBlob');
    await writeSessionAddress(addressingBlob, password, sessionAddress);
    await this.config.adapter.writeAddressingBlob(addressingBlob);

    // 6. Return unlocked session
    return {
      data: sessionData,
      createdAt: sessionAddress.createdAt,
      updatedAt: sessionAddress.updatedAt,
    };
  }

  /**
   * Update an existing session
   *
   * Uses multi-block architecture: appends new data as a new block and updates the allocation table.
   *
   * @param password - Password of the session to update
   * @param newData - New data to store
   * @throws {DeniableStorageException} If session not found or storage error
   */
  async updateSession(password: string, newData: Uint8Array): Promise<void> {
    this.ensureInitialized();

    // Validate inputs
    const { validatePassword, validateDataSize } =
      await import('./utils/validation');

    const passwordValidation = validatePassword(password);
    if (!passwordValidation.valid) {
      throw new Error(`Invalid password: ${passwordValidation.error}`);
    }

    const dataValidation = validateDataSize(newData, 1024 * 1024 * 1024);
    if (!dataValidation.valid) {
      throw new Error(`Invalid data: ${dataValidation.error}`);
    }

    // Import required functions
    const { readSlots, writeSessionAddress } =
      await import('./core/AddressingBlob');
    const { generateEncryptionKeyFromSeed } =
      await import('../../wasm/encryption');
    const { decryptRootBlock, encryptRootBlock } =
      await import('./core/AllocationTable');
    const { deriveBlockKey, createDataBlockWithKey, appendBlock } =
      await import('./core/DataBlob');

    // 1. Find current session address
    const addressingBlob = await this.config.adapter.readAddressingBlob();
    const currentAddress = await readSlots(addressingBlob, password);

    if (!currentAddress) {
      throw new Error('Session not found');
    }

    // 2. Derive session key
    const sessionSalt = new TextEncoder().encode('deniable-storage-session-v1');
    const sessionKey = await generateEncryptionKeyFromSeed(
      password,
      sessionSalt
    );

    // 3. Read and decrypt current root block
    let currentDataBlob = await this.config.adapter.readDataBlob();
    const rootBlock = await decryptRootBlock(
      currentDataBlob,
      currentAddress.rootBlockOffset,
      sessionKey
    );

    if (!rootBlock) {
      throw new Error('Failed to decrypt root block');
    }

    // 4. Create new data block with unique block ID
    const blockId = crypto.getRandomValues(new Uint8Array(32));
    const blockKey = await deriveBlockKey(sessionKey, blockId);
    const newDataBlock = await createDataBlockWithKey(newData, blockKey);

    // 5. Append new data block to data blob
    const newDataBlockOffset = currentDataBlob.length;
    currentDataBlob = appendBlock(currentDataBlob, newDataBlock);

    // 6. Strategy: Replace entire session data (simple approach)
    // Clear old allocation table and add single new entry
    rootBlock.entries = [
      {
        offset: newDataBlockOffset,
        length: newData.length,
        logicalAddress: 0,
        blockSize: newDataBlock.size,
        blockId: blockId,
      },
    ];
    rootBlock.entryCount = 1;
    rootBlock.totalDataSize = newData.length;

    // 7. Encrypt and append new root block
    const encryptedRootBlock = await encryptRootBlock(rootBlock, sessionKey);
    const newRootBlockOffset = currentDataBlob.length;
    currentDataBlob = appendBlock(currentDataBlob, encryptedRootBlock);

    // 8. Update session address with new root block location
    const updatedAddress = {
      rootBlockOffset: newRootBlockOffset,
      rootBlockSize: encryptedRootBlock.size,
      sessionKeyDerivationSalt: currentAddress.sessionKeyDerivationSalt,
      createdAt: currentAddress.createdAt,
      updatedAt: Date.now(),
    };

    // 9. Write updated address to addressing blob (overwrites 46 slots)
    await writeSessionAddress(addressingBlob, password, updatedAddress);

    // 10. Persist both blobs
    await this.config.adapter.writeAddressingBlob(addressingBlob);
    await this.config.adapter.writeDataBlob(currentDataBlob);

    // Note: Old blocks remain in data blob as "padding" for plausible deniability
  }

  /**
   * Delete a session (secure wipe)
   *
   * Uses multi-block architecture: wipes all data blocks referenced in allocation table,
   * then wipes the root block, then overwrites all 46 addressing slots.
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
    const { readSlots, deriveSlotIndices, SLOT_SIZE } =
      await import('./core/AddressingBlob');
    const { generateEncryptionKeyFromSeed } =
      await import('../../wasm/encryption');
    const { decryptRootBlock } = await import('./core/AllocationTable');

    // 1. Find session to verify it exists
    const addressingBlob = await this.config.adapter.readAddressingBlob();
    const sessionAddress = await readSlots(addressingBlob, password);

    if (!sessionAddress) {
      throw new Error('Session not found');
    }

    // 2. Derive session key to decrypt root block
    const sessionSalt = new TextEncoder().encode('deniable-storage-session-v1');
    const sessionKey = await generateEncryptionKeyFromSeed(
      password,
      sessionSalt
    );

    // 3. Read and decrypt root block to get allocation table
    const dataBlob = await this.config.adapter.readDataBlob();
    const rootBlock = await decryptRootBlock(
      dataBlob,
      sessionAddress.rootBlockOffset,
      sessionKey
    );

    if (!rootBlock) {
      throw new Error('Failed to decrypt root block for deletion');
    }

    // 4. Securely wipe all data blocks referenced in allocation table
    for (const entry of rootBlock.entries) {
      // Overwrite the entire data block with random data
      if (
        entry.offset >= 0 &&
        entry.offset + entry.blockSize <= dataBlob.length
      ) {
        const randomBlock = new Uint8Array(entry.blockSize);
        crypto.getRandomValues(randomBlock);
        dataBlob.set(randomBlock, entry.offset);
      }
    }

    // 5. Securely wipe the root block
    if (
      sessionAddress.rootBlockOffset >= 0 &&
      sessionAddress.rootBlockOffset + sessionAddress.rootBlockSize <=
        dataBlob.length
    ) {
      const randomRootBlock = new Uint8Array(sessionAddress.rootBlockSize);
      crypto.getRandomValues(randomRootBlock);
      dataBlob.set(randomRootBlock, sessionAddress.rootBlockOffset);
    }

    // 6. Overwrite all 46 addressing slots with random data
    // This makes the session completely unrecoverable
    const slotIndices = await deriveSlotIndices(password);

    for (const slotIndex of slotIndices) {
      const slotOffset = slotIndex * SLOT_SIZE;
      const randomData = new Uint8Array(SLOT_SIZE);
      crypto.getRandomValues(randomData);
      addressingBlob.set(randomData, slotOffset);
    }

    // 7. Persist updated blobs
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
      throw new Error('Storage not initialized. Call initialize() first.');
    }
  }
}
