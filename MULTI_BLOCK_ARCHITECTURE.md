# Multi-Block Architecture Design

This document describes the implementation plan for multi-block session support with allocation tables, as specified in GitHub issue #321.

---

## Overview

Current implementation uses a simplified single-block approach where each session's data is stored in one encrypted block. The spec requires a more sophisticated architecture with:

1. **Root Block** - Contains allocation table with references to data blocks
2. **Data Blocks** - Store actual user data with block-specific encryption
3. **Block-ID-Derived Keys** - Each block encrypted with `kdf(session_key, block_id)`
4. **Allocation Table** - Maps logical offsets to physical block locations

---

## Current vs. Spec Architecture

### Current (Simplified)

```
Session Address (in 46 slots):
{
  offset: number,        // Points to single encrypted block
  blockSize: number,     // Size of that block
  createdAt: number,
  updatedAt: number,
  salt: Uint8Array(16)
}

Data Blob:
[padding][block_header: 4][nonce: 16][ciphertext][padding][next block...]
```

### Spec (Multi-Block)

```
Session Address (in 46 slots):
{
  rootBlockOffset: number,     // Points to root block
  rootBlockSize: number,       // Size of root block
  createdAt: number,
  updatedAt: number,
  salt: Uint8Array(16)
}

Root Block:
- Encrypted with session key derived from password
- Contains allocation table with entries:
  [offset: 8][length: 4][logicalAddress: 8][size: 4][blockId: 32] = 56 bytes
- Capacity: ~37,000 entries in 2 MB root block

Data Blocks:
- Each encrypted with kdf(session_key, block_id)
- Independent encryption per block
- Support partial reads/writes
```

---

## Data Structures

### 1. Allocation Table Entry

```typescript
interface AllocationEntry {
  // Physical location in data blob
  offset: number; // 8 bytes - where block starts
  length: number; // 4 bytes - actual data length (≤ blockSize)

  // Logical addressing
  logicalAddress: number; // 8 bytes - logical byte offset in session
  blockSize: number; // 4 bytes - total block size (including padding)

  // Encryption
  blockId: Uint8Array; // 32 bytes - unique ID for key derivation
}

// Total: 56 bytes per entry
```

### 2. Root Block Structure

```typescript
interface RootBlock {
  version: number; // 4 bytes - format version (1)
  entryCount: number; // 4 bytes - number of entries
  totalDataSize: number; // 8 bytes - total logical data size
  entries: AllocationEntry[]; // Variable size

  // Serialized format:
  // [version: 4][entryCount: 4][totalDataSize: 8][entries...]
  // Each entry: 56 bytes
  // Capacity in 2 MB: (2*1024*1024 - 16) / 56 ≈ 37,448 entries
}
```

### 3. Updated Session Address

```typescript
interface SessionAddress {
  rootBlockOffset: number; // Points to root block (not data)
  rootBlockSize: number; // Size of root block
  sessionKeyDerivationSalt: Uint8Array; // 16 bytes for session key
  createdAt: number;
  updatedAt: number;
}
```

---

## Key Derivation Strategy

### Session Key (from password)

```typescript
// Derive master session key from password
const sessionSalt = new TextEncoder().encode('deniable-storage-session-v1');
const sessionKey = await generateEncryptionKeyFromSeed(password, sessionSalt);
```

### Root Block Key (from session key)

```typescript
// Derive root block key from session key
const rootBlockSalt = new TextEncoder().encode('root-block-v1');
const rootBlockKey = await generateEncryptionKeyFromSeed(
  sessionKey.to_hex(),
  rootBlockSalt
);
```

### Data Block Key (from session key + block ID)

```typescript
// Per spec: block_key = kdf(session_aead_key, [block_id])
const blockKey = await generateEncryptionKeyFromSeed(
  sessionKey.to_hex(),
  blockId // 32-byte unique identifier
);
```

**Key Hierarchy:**

```
Password
  ↓ (Argon2id)
Session Key
  ├→ (labeled KDF: "root-block-v1") → Root Block Key
  └→ (labeled KDF: blockId) → Data Block Keys (one per block)
```

---

## Implementation Plan

### Phase 6.1: Core Data Structures ✅

**New file:** `src/storage/deniable/core/AllocationTable.ts`

```typescript
export interface AllocationEntry {
  offset: number;
  length: number;
  logicalAddress: number;
  blockSize: number;
  blockId: Uint8Array;
}

export interface RootBlock {
  version: number;
  entryCount: number;
  totalDataSize: number;
  entries: AllocationEntry[];
}

// Serialize root block to bytes
export function serializeRootBlock(rootBlock: RootBlock): Uint8Array;

// Deserialize bytes to root block
export function deserializeRootBlock(bytes: Uint8Array): RootBlock;

// Create empty root block
export function createRootBlock(): RootBlock;

// Add entry to allocation table
export function addAllocationEntry(
  rootBlock: RootBlock,
  entry: AllocationEntry
): void;

// Find entry by logical address
export function findEntryByAddress(
  rootBlock: RootBlock,
  logicalAddress: number
): AllocationEntry | null;

// Get entries spanning a range
export function getEntriesInRange(
  rootBlock: RootBlock,
  startAddress: number,
  length: number
): AllocationEntry[];
```

### Phase 6.2: Block-ID-Derived Key Derivation ✅

**Update:** `src/storage/deniable/core/DataBlob.ts`

```typescript
/**
 * Derives a block-specific encryption key
 * Per spec: block_key = kdf(session_aead_key, [block_id])
 */
export async function deriveBlockKey(
  sessionKey: EncryptionKey,
  blockId: Uint8Array
): Promise<EncryptionKey> {
  const { generateEncryptionKeyFromSeed } =
    await import('../../../wasm/encryption');

  // Use session key as password, blockId as salt
  return await generateEncryptionKeyFromSeed(sessionKey.to_hex(), blockId);
}

/**
 * Creates an encrypted data block with block-ID-derived key
 */
export async function createDataBlockWithBlockId(
  data: Uint8Array,
  sessionKey: EncryptionKey,
  blockId: Uint8Array
): Promise<DataBlock>;
```

### Phase 6.3: Root Block Operations ✅

**New functions in:** `src/storage/deniable/core/AllocationTable.ts`

```typescript
/**
 * Encrypts root block with session key
 */
export async function encryptRootBlock(
  rootBlock: RootBlock,
  sessionKey: EncryptionKey
): Promise<DataBlock>;

/**
 * Decrypts and parses root block
 */
export async function decryptRootBlock(
  encryptedBlock: Uint8Array,
  offset: number,
  sessionKey: EncryptionKey
): Promise<RootBlock | null>;
```

### Phase 6.4: Update Session Creation ✅

**Update:** `src/storage/deniable/DeniableStorage.ts#createSession()`

```typescript
async createSession(password: string, data: Uint8Array): Promise<void> {
  // 1. Derive session key from password
  const sessionKey = await generateEncryptionKeyFromSeed(password, sessionSalt);

  // 2. Create initial data block with random block ID
  const blockId = crypto.getRandomValues(new Uint8Array(32));
  const blockKey = await deriveBlockKey(sessionKey, blockId);
  const dataBlock = await createDataBlockWithBlockId(data, blockKey, blockId);

  // 3. Append data block to data blob
  const currentDataBlob = await this.adapter.readDataBlob();
  const dataBlockOffset = currentDataBlob.length;
  const newDataBlob = appendBlock(currentDataBlob, dataBlock);

  // 4. Create allocation table entry
  const entry: AllocationEntry = {
    offset: dataBlockOffset,
    length: data.length,
    logicalAddress: 0,
    blockSize: dataBlock.size,
    blockId: blockId
  };

  // 5. Create root block with allocation table
  const rootBlock = createRootBlock();
  rootBlock.entries.push(entry);
  rootBlock.totalDataSize = data.length;
  rootBlock.entryCount = 1;

  // 6. Encrypt and append root block
  const encryptedRootBlock = await encryptRootBlock(rootBlock, sessionKey);
  const rootBlockOffset = newDataBlob.length;
  const finalDataBlob = appendBlock(newDataBlob, encryptedRootBlock);

  // 7. Create session address pointing to root block
  const sessionAddress = {
    rootBlockOffset: rootBlockOffset,
    rootBlockSize: encryptedRootBlock.size,
    sessionKeyDerivationSalt: crypto.getRandomValues(new Uint8Array(16)),
    createdAt: Date.now(),
    updatedAt: Date.now()
  };

  // 8. Write to addressing blob (46 slots)
  const addressingBlob = await this.adapter.readAddressingBlob();
  await writeSessionAddress(addressingBlob, password, sessionAddress);

  // 9. Persist
  await this.adapter.writeAddressingBlob(addressingBlob);
  await this.adapter.writeDataBlob(finalDataBlob);
}
```

### Phase 6.5: Update Session Unlock ✅

**Update:** `src/storage/deniable/DeniableStorage.ts#unlockSession()`

```typescript
async unlockSession(password: string): Promise<UnlockResult | null> {
  // 1. Find session address (timing-safe)
  const addressingBlob = await this.adapter.readAddressingBlob();
  const sessionAddress = await readSlots(addressingBlob, password);
  if (!sessionAddress) return null;

  // 2. Derive session key
  const sessionKey = await generateEncryptionKeyFromSeed(
    password,
    sessionAddress.sessionKeyDerivationSalt
  );

  // 3. Read and decrypt root block
  const dataBlob = await this.adapter.readDataBlob();
  const rootBlock = await decryptRootBlock(
    dataBlob,
    sessionAddress.rootBlockOffset,
    sessionKey
  );
  if (!rootBlock) return null;

  // 4. Reconstruct full session data from allocation table
  const totalSize = rootBlock.totalDataSize;
  const sessionData = new Uint8Array(totalSize);

  for (const entry of rootBlock.entries) {
    // Derive block key
    const blockKey = await deriveBlockKey(sessionKey, entry.blockId);

    // Decrypt block
    const blockData = await parseDataBlobWithKey(
      dataBlob,
      entry.offset,
      blockKey
    );
    if (!blockData) return null;

    // Copy to correct logical position
    sessionData.set(blockData.slice(0, entry.length), entry.logicalAddress);
  }

  return {
    data: sessionData,
    createdAt: sessionAddress.createdAt,
    updatedAt: sessionAddress.updatedAt
  };
}
```

### Phase 6.6: Offset-Based Read/Write ✅

**New methods in:** `src/storage/deniable/DeniableStorage.ts`

```typescript
/**
 * Read data at logical offset
 * Transparently handles block spanning
 */
async read(
  password: string,
  offset: number,
  length: number
): Promise<Uint8Array | null>;

/**
 * Write data at logical offset
 * Creates new blocks as needed
 */
async write(
  password: string,
  offset: number,
  data: Uint8Array
): Promise<void>;

/**
 * Append data to end of session
 */
async append(password: string, data: Uint8Array): Promise<void>;
```

---

## Migration Strategy

### Option 1: Version Flag (Backward Compatible)

Add version field to session address:

```typescript
interface SessionAddress {
  version: 1 | 2; // 1 = old single-block, 2 = new multi-block
  // ... rest of fields depend on version
}
```

**Pros:** Existing sessions continue working
**Cons:** Code complexity maintaining two paths

### Option 2: Clean Break (Recommended)

Simply change the implementation. Old data blobs are incompatible.

**Pros:** Clean architecture, no technical debt
**Cons:** Requires re-creating sessions

**Decision:** Use Option 2 (clean break) since this is pre-production.

---

## Testing Strategy

### Unit Tests

1. ✅ Allocation table serialization/deserialization
2. ✅ Entry management (add, find, range queries)
3. ✅ Block-ID key derivation uniqueness
4. ✅ Root block encryption/decryption
5. ✅ Multi-block session creation
6. ✅ Multi-block session unlock
7. ✅ Offset-based read/write
8. ✅ Block spanning edge cases

### Integration Tests

1. ✅ Create session with 1 block
2. ✅ Create session with 10 blocks (>100 MB)
3. ✅ Create session with 100 blocks (>1 GB)
4. ✅ Update session (append blocks)
5. ✅ Read/write at various offsets
6. ✅ Verify allocation table correctness

### Performance Tests

1. ✅ Session unlock time vs. block count
2. ✅ Random read performance
3. ✅ Sequential write performance
4. ✅ Allocation table capacity (37,000 entries)

---

## Capacity Analysis

### Root Block (2 MB minimum)

```
Header: 16 bytes
Entry size: 56 bytes
Entries per 2 MB: (2*1024*1024 - 16) / 56 ≈ 37,448 entries

With 35 MB average block size:
Max session size = 37,448 × 35 MB ≈ 1.28 TB
```

### Scaling

If root block grows beyond 2 MB, it just becomes a larger block. The 2 MB minimum ensures I/O efficiency, but there's no maximum.

For sessions > 1 TB, could implement hierarchical allocation (root block points to sub-allocation tables).

---

## Implementation Timeline

| Phase | Description             | Estimated Lines | Priority |
| ----- | ----------------------- | --------------- | -------- |
| 6.1   | AllocationTable.ts      | ~300            | HIGH     |
| 6.2   | Block-ID key derivation | ~50             | HIGH     |
| 6.3   | Root block operations   | ~150            | HIGH     |
| 6.4   | Update createSession    | ~100            | HIGH     |
| 6.5   | Update unlockSession    | ~150            | HIGH     |
| 6.6   | Offset-based I/O        | ~200            | MEDIUM   |
| 6.7   | Tests                   | ~500            | HIGH     |

**Total:** ~1,450 lines of new/modified code

---

## Next Steps

1. ✅ Create `AllocationTable.ts` with core data structures
2. ✅ Implement serialization/deserialization
3. ✅ Add block-ID key derivation to `DataBlob.ts`
4. ✅ Implement root block encryption
5. ✅ Update `types.ts` with new interfaces
6. ✅ Update `DeniableStorage.ts` for multi-block
7. ✅ Add comprehensive tests
8. ✅ Update documentation

**Ready to begin implementation.**
