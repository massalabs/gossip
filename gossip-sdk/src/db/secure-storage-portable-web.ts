import { sha256 } from '@noble/hashes/sha2';
import { SESSION_COUNT } from './secure-storage-namespaces.js';

const DB_NAME = 'secure_storage';
const STORE_NAME = 'blocks';
const HEADER_BYTES = 40;
const FRAME_BYTES = 26;
const DIGEST_BYTES = 32;
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024 * 1024;
const BLOCK_BYTES = 65_536;
const MAGIC = new TextEncoder().encode('GOSSIPBK');
const EXPORT_SPOOL_PREFIX = 'x:portable-export:';
const IMPORT_SPOOL_PREFIX = 'x:portable-import:';
const ACTIVE_GENERATION_KEY = 'm:active-generation';
const LEGACY_GENERATION = 'legacy';
const MAX_TRANSFER_CHUNK_BYTES = 1024 * 1024;
const MAX_KEYPAIR_VALUE_BYTES = 16 * 1024 * 1024;
const MAX_QUEUED_IMPORT_BYTES = 2 * MAX_TRANSFER_CHUNK_BYTES;

interface LogicalKeypair {
  kind: 'keypair';
  slot: number;
}

interface LogicalBlock {
  kind: 'block';
  slot: number;
  namespace: number;
  blockIndex: number;
}

type LogicalKey = LogicalKeypair | LogicalBlock;

type RecordValidator = (value: Uint8Array) => void;

export interface PortableWebValidators {
  validateKeypair: RecordValidator;
  validateBlock: RecordValidator;
}

interface Layout {
  recordCount: number;
  recordBytes: number;
  blockCounts: [number, number];
}

interface CrossTabLease {
  release(): void;
  completion: Promise<void>;
}

const EXPORT_LOCK_NAME = 'gossip-secure-storage-portable-export';
const INSTALLATION_FENCE_LOCK_NAME = 'gossip-secure-storage-generation-install';

async function acquireExportLease(
  signal?: AbortSignal
): Promise<CrossTabLease> {
  if (!navigator.locks) {
    throw new Error('This browser cannot safely coordinate backup export');
  }
  let acquired!: () => void;
  let acquisitionFailed!: (reason: unknown) => void;
  let release!: () => void;
  const acquiredPromise = new Promise<void>((resolve, reject) => {
    acquired = resolve;
    acquisitionFailed = reject;
  });
  const hold = new Promise<void>(resolve => {
    release = resolve;
  });
  const completion = navigator.locks.request<void>(
    EXPORT_LOCK_NAME,
    { mode: 'exclusive', signal },
    async () => {
      acquired();
      await hold;
    }
  );
  void completion.catch(acquisitionFailed);
  await acquiredPromise;
  return { release, completion };
}

function asBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new Error('Invalid secure-storage record');
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () =>
      reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function abortTransaction(tx: IDBTransaction): void {
  try {
    tx.abort();
  } catch {
    // The transaction may already have aborted in response to cancellation.
  }
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () =>
      reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    tx.onerror = () =>
      reject(tx.error ?? new Error('IndexedDB transaction failed'));
  });
}

async function openDatabase(): Promise<IDBDatabase> {
  const req = indexedDB.open(DB_NAME);
  const db = await request(req);
  if (!db.objectStoreNames.contains(STORE_NAME)) {
    db.close();
    throw new Error('Secure storage is unavailable');
  }
  return db;
}

async function deleteSpools(db: IDBDatabase, prefix: string): Promise<void> {
  const tx = db.transaction(STORE_NAME, 'readwrite');
  const done = transactionDone(tx);
  const store = tx.objectStore(STORE_NAME);
  await new Promise<void>((resolve, reject) => {
    const cursorRequest = store.openKeyCursor();
    cursorRequest.onerror = () =>
      reject(cursorRequest.error ?? new Error('IndexedDB cursor failed'));
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) {
        resolve();
        return;
      }
      if (typeof cursor.key === 'string' && cursor.key.startsWith(prefix)) {
        store.delete(cursor.key);
      }
      cursor.continue();
    };
  });
  await done;
}

function parseKey(raw: IDBValidKey): LogicalKey {
  if (typeof raw !== 'string') throw new Error('Invalid secure-storage key');
  const keypair = /^s:(0|1|2):kp$/.exec(raw);
  if (keypair) return { kind: 'keypair', slot: Number(keypair[1]) };
  const block = /^s:(0|1|2):n:(0|1):b:(0|[1-9][0-9]*)$/.exec(raw);
  if (!block) throw new Error('Invalid secure-storage key');
  const blockIndex = Number(block[3]);
  if (!Number.isSafeInteger(blockIndex)) {
    throw new Error('Invalid secure-storage block index');
  }
  return {
    kind: 'block',
    slot: Number(block[1]),
    namespace: Number(block[2]),
    blockIndex,
  };
}

function encodedKey(key: LogicalKey): string {
  if (key.kind === 'keypair') return `s:${key.slot}:kp`;
  return `s:${key.slot}:n:${key.namespace}:b:${key.blockIndex}`;
}

function checkedAdd(left: number, right: number): number {
  const value = left + right;
  if (!Number.isSafeInteger(value) || value > MAX_ARCHIVE_BYTES) {
    throw new Error('Portable backup is too large');
  }
  return value;
}

function randomTransferId(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

function spoolPrefix(transferId: string): string {
  return `${EXPORT_SPOOL_PREFIX}${transferId}:`;
}

function activeRecordPrefix(generation: string): string {
  return generation === LEGACY_GENERATION ? '' : `g:${generation}:`;
}

async function inspectAndSnapshotLayout(
  db: IDBDatabase,
  transferId: string,
  validators: PortableWebValidators,
  generation: string,
  signal?: AbortSignal
): Promise<Layout> {
  const keypairs = Array<boolean>(SESSION_COUNT).fill(false);
  const counts = Array.from({ length: SESSION_COUNT }, () => [0, 0]);
  const maxima = Array.from({ length: SESSION_COUNT }, () => [-1, -1]);
  let recordCount = 0;
  let recordBytes = 0;

  // One readwrite transaction both observes a coherent source generation and
  // copies it to an export-owned prefix. Later destination backpressure cannot
  // keep an IndexedDB transaction alive, so streaming reads use this immutable
  // spool rather than mixing records committed by another tab between chunks.
  if (signal?.aborted) throw new DOMException('Backup cancelled', 'AbortError');
  const tx = db.transaction(STORE_NAME, 'readwrite');
  const abort = () => abortTransaction(tx);
  signal?.addEventListener('abort', abort, { once: true });
  const store = tx.objectStore(STORE_NAME);
  const prefix = spoolPrefix(transferId);
  const activePrefix = activeRecordPrefix(generation);
  let layout: Layout | null = null;
  const done = transactionDone(tx);
  // The cursor path reports the more specific validation error. Attach an
  // abort handler immediately so that transaction rejection is not unhandled
  // when validation intentionally aborts before the later `await done`.
  void done.catch(() => {});
  await new Promise<void>((resolve, reject) => {
    const cursorRequest = store.openCursor(
      IDBKeyRange.bound(`${activePrefix}s:`, `${activePrefix}s;`, false, true)
    );
    cursorRequest.onerror = () =>
      reject(cursorRequest.error ?? new Error('IndexedDB cursor failed'));
    cursorRequest.onsuccess = () => {
      try {
        const cursor = cursorRequest.result;
        if (!cursor) {
          if (keypairs.some(present => !present)) {
            throw new Error('Incomplete secure-storage key set');
          }
          for (let namespace = 0; namespace < 2; namespace += 1) {
            const expected = counts[0][namespace];
            if (counts.some(perSlot => perSlot[namespace] !== expected)) {
              throw new Error('Unequal secure-storage slot layout');
            }
            for (let slot = 0; slot < SESSION_COUNT; slot += 1) {
              if (
                counts[slot][namespace] !== 0 &&
                maxima[slot][namespace] + 1 !== counts[slot][namespace]
              ) {
                throw new Error('Non-contiguous secure-storage block layout');
              }
            }
          }
          if (counts[0][0] === 0) {
            throw new Error('Missing required secure-storage data');
          }
          const blockLocations = counts[0][0] + counts[0][1];
          if (recordCount !== SESSION_COUNT + SESSION_COUNT * blockLocations) {
            throw new Error('Invalid portable record count');
          }
          checkedAdd(checkedAdd(HEADER_BYTES, recordBytes), DIGEST_BYTES);
          layout = {
            recordCount,
            recordBytes,
            blockCounts: [counts[0][0], counts[0][1]],
          };
          resolve();
          return;
        }
        if (typeof cursor.key !== 'string') {
          throw new Error('Invalid secure-storage key');
        }
        const key = parseKey(cursor.key.slice(activePrefix.length));
        const value = asBytes(cursor.value);
        if (key.kind === 'keypair') {
          if (keypairs[key.slot]) throw new Error('Duplicate storage key');
          validators.validateKeypair(value);
          keypairs[key.slot] = true;
        } else {
          if (value.byteLength !== BLOCK_BYTES) {
            throw new Error('Invalid secure-storage block size');
          }
          validators.validateBlock(value);
          counts[key.slot][key.namespace] += 1;
          maxima[key.slot][key.namespace] = Math.max(
            maxima[key.slot][key.namespace],
            key.blockIndex
          );
        }
        recordCount = checkedAdd(recordCount, 1);
        recordBytes = checkedAdd(
          recordBytes,
          checkedAdd(FRAME_BYTES, value.byteLength)
        );
        store.put(value, `${prefix}${encodedKey(key)}`);
        cursor.continue();
      } catch (error) {
        abortTransaction(tx);
        reject(
          signal?.aborted
            ? new DOMException('Backup cancelled', 'AbortError')
            : error
        );
      }
    };
  });
  try {
    await done;
  } catch (error) {
    if (signal?.aborted) {
      throw new DOMException('Backup cancelled', 'AbortError');
    }
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
  }
  if (!layout) throw new Error('Invalid portable layout');
  return layout;
}

function writeU64(view: DataView, offset: number, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('Invalid portable integer');
  }
  view.setBigUint64(offset, BigInt(value), false);
}

function header(layout: Layout): Uint8Array {
  const bytes = new Uint8Array(HEADER_BYTES);
  bytes.set(MAGIC, 0);
  const view = new DataView(bytes.buffer);
  writeU64(view, 8, 1);
  writeU64(view, 16, SESSION_COUNT);
  writeU64(view, 24, layout.recordCount);
  writeU64(view, 32, layout.recordBytes);
  return bytes;
}

function frame(key: LogicalKey, valueLength: number): Uint8Array {
  const bytes = new Uint8Array(FRAME_BYTES);
  const view = new DataView(bytes.buffer);
  bytes[0] = key.kind === 'keypair' ? 0 : 1;
  bytes[1] = key.slot;
  writeU64(view, 2, key.kind === 'block' ? key.namespace : 0);
  writeU64(view, 10, key.kind === 'block' ? key.blockIndex : 0);
  writeU64(view, 18, valueLength);
  return bytes;
}

function concatenate(left: Uint8Array, right: Uint8Array): Uint8Array {
  const out = new Uint8Array(left.byteLength + right.byteLength);
  out.set(left, 0);
  out.set(right, left.byteLength);
  return out;
}

async function readRecord(
  db: IDBDatabase,
  transferId: string,
  key: LogicalKey
): Promise<Uint8Array> {
  const tx = db.transaction(STORE_NAME, 'readonly');
  const value = await request(
    tx
      .objectStore(STORE_NAME)
      .get(`${spoolPrefix(transferId)}${encodedKey(key)}`)
  );
  await transactionDone(tx);
  if (value === undefined)
    throw new Error('Secure storage changed during export');
  return asBytes(value);
}

export class PortableWebExport {
  private readonly hash = sha256.create();
  private stage: 'header' | 'keypairs' | 'blocks' | 'digest' | 'done' =
    'header';
  private slot = 0;
  private namespace = 0;
  private blockIndex = 0;
  private pending: Uint8Array | null = null;
  private pendingOffset = 0;

  private constructor(
    private db: IDBDatabase | null,
    private readonly lease: CrossTabLease,
    private readonly transferId: string,
    private readonly layout: Layout,
    private readonly validators: PortableWebValidators
  ) {}

  static async cleanupInterrupted(): Promise<void> {
    // Web Locks are required for cross-tab-safe export, but not for ordinary
    // secure-storage use. Rust excludes `x:` values from startup state, so an
    // older browser can safely defer cleanup while export remains unavailable.
    if (!navigator.locks) return;
    const lease = await acquireExportLease();
    let db: IDBDatabase | null = null;
    try {
      db = await openDatabase();
      await deleteSpools(db, EXPORT_SPOOL_PREFIX);
      await deleteSpools(db, IMPORT_SPOOL_PREFIX);
      await cleanupInactiveGenerations(db);
    } finally {
      db?.close();
      lease.release();
      await lease.completion;
    }
  }

  static async begin(
    validators: PortableWebValidators,
    signal?: AbortSignal
  ): Promise<PortableWebExport> {
    const lease = await acquireExportLease(signal);
    let db: IDBDatabase | null = null;
    try {
      db = await openDatabase();
      await deleteSpools(db, EXPORT_SPOOL_PREFIX);
      await deleteSpools(db, IMPORT_SPOOL_PREFIX);
      await cleanupInactiveGenerations(db);
      const transferId = randomTransferId();
      const generation = await readActiveGeneration(db);
      const layout = await inspectAndSnapshotLayout(
        db,
        transferId,
        validators,
        generation,
        signal
      );
      return new PortableWebExport(db, lease, transferId, layout, validators);
    } catch (error) {
      db?.close();
      lease.release();
      await lease.completion;
      throw error;
    }
  }

  get totalBytes(): number {
    return HEADER_BYTES + this.layout.recordBytes + DIGEST_BYTES;
  }

  private nextKey(): LogicalKey | null {
    if (this.stage === 'keypairs') {
      if (this.slot < SESSION_COUNT) {
        return { kind: 'keypair', slot: this.slot++ };
      }
      this.stage = 'blocks';
      this.slot = 0;
    }
    if (this.stage !== 'blocks') return null;
    while (this.namespace < 2) {
      if (this.blockIndex >= this.layout.blockCounts[this.namespace]) {
        this.namespace += 1;
        this.blockIndex = 0;
        this.slot = 0;
        continue;
      }
      const key: LogicalBlock = {
        kind: 'block',
        namespace: this.namespace,
        blockIndex: this.blockIndex,
        slot: this.slot,
      };
      this.slot += 1;
      if (this.slot === SESSION_COUNT) {
        this.slot = 0;
        this.blockIndex += 1;
      }
      return key;
    }
    this.stage = 'digest';
    return null;
  }

  private async nextPiece(): Promise<Uint8Array | null> {
    if (this.stage === 'header') {
      this.stage = 'keypairs';
      const bytes = header(this.layout);
      this.hash.update(bytes);
      return bytes;
    }
    const key = this.nextKey();
    if (key) {
      if (!this.db) this.db = await openDatabase();
      const value = await readRecord(this.db, this.transferId, key);
      if (key.kind === 'keypair') this.validators.validateKeypair(value);
      else this.validators.validateBlock(value);
      const bytes = concatenate(frame(key, value.byteLength), value);
      this.hash.update(bytes);
      return bytes;
    }
    if (this.stage === 'digest') {
      this.stage = 'done';
      return this.hash.digest();
    }
    return null;
  }

  async read(maxBytes: number): Promise<Uint8Array | null> {
    if (
      !Number.isInteger(maxBytes) ||
      maxBytes <= 0 ||
      maxBytes > MAX_TRANSFER_CHUNK_BYTES
    ) {
      throw new Error('Invalid portable export chunk size');
    }
    if (this.stage === 'done' && this.pending === null) return null;
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (length < maxBytes) {
      if (this.pending === null) {
        this.pending = await this.nextPiece();
        this.pendingOffset = 0;
        if (this.pending === null) break;
      }
      const available = this.pending.byteLength - this.pendingOffset;
      const take = Math.min(available, maxBytes - length);
      chunks.push(
        this.pending.subarray(this.pendingOffset, this.pendingOffset + take)
      );
      this.pendingOffset += take;
      length += take;
      if (this.pendingOffset === this.pending.byteLength) {
        this.pending = null;
        this.pendingOffset = 0;
      }
    }
    if (length === 0) return null;
    const out = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  }

  async close(): Promise<void> {
    this.pending?.fill(0);
    this.pending = null;
    this.stage = 'done';
    if (!this.db) this.db = await openDatabase();
    try {
      await deleteSpools(this.db, spoolPrefix(this.transferId));
    } catch (error) {
      // Keep the lease and transfer object retryable, but discard the failed
      // connection so abortPortableTransfer can reopen and retry cleanup.
      this.db.close();
      this.db = null;
      throw error;
    }
    this.db.close();
    this.db = null;
    this.lease.release();
    await this.lease.completion;
  }
}

function readPortableU64(view: DataView, offset: number): number {
  const value = view.getBigUint64(offset, false);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Portable backup integer is too large');
  }
  return Number(value);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

async function readActiveGeneration(db: IDBDatabase): Promise<string> {
  const tx = db.transaction(STORE_NAME, 'readonly');
  const existing = await request(
    tx.objectStore(STORE_NAME).get(ACTIVE_GENERATION_KEY)
  );
  await transactionDone(tx);
  if (existing === undefined) return LEGACY_GENERATION;
  if (
    typeof existing === 'string' &&
    (existing === LEGACY_GENERATION || /^[0-9a-f]{32}$/.test(existing))
  ) {
    return existing;
  }
  throw new Error('Invalid secure-storage generation marker');
}

function prefixRange(prefix: string): IDBKeyRange {
  if (!prefix.endsWith(':')) throw new Error('Invalid storage prefix');
  return IDBKeyRange.bound(prefix, `${prefix.slice(0, -1)};`, false, true);
}

async function deletePrefix(db: IDBDatabase, prefix: string): Promise<void> {
  const tx = db.transaction(STORE_NAME, 'readwrite');
  const store = tx.objectStore(STORE_NAME);
  await new Promise<void>((resolve, reject) => {
    const cursorRequest = store.openKeyCursor(prefixRange(prefix));
    cursorRequest.onerror = () =>
      reject(cursorRequest.error ?? new Error('IndexedDB cursor failed'));
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) {
        resolve();
        return;
      }
      store.delete(cursor.key);
      cursor.continue();
    };
  });
  await transactionDone(tx);
}

async function cleanupInactiveGenerations(db: IDBDatabase): Promise<void> {
  const active = await readActiveGeneration(db);
  const activePrefix = activeRecordPrefix(active);
  const tx = db.transaction(STORE_NAME, 'readwrite');
  const store = tx.objectStore(STORE_NAME);
  await new Promise<void>((resolve, reject) => {
    const cursorRequest = store.openKeyCursor(prefixRange('g:'));
    cursorRequest.onerror = () =>
      reject(cursorRequest.error ?? new Error('IndexedDB cursor failed'));
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) {
        resolve();
        return;
      }
      if (
        active === LEGACY_GENERATION ||
        typeof cursor.key !== 'string' ||
        !cursor.key.startsWith(activePrefix)
      ) {
        store.delete(cursor.key);
      }
      cursor.continue();
    };
  });
  await transactionDone(tx);
}

async function stageCandidateGeneration(
  db: IDBDatabase,
  transferId: string,
  generation: string
): Promise<void> {
  const tx = db.transaction(STORE_NAME, 'readwrite');
  const done = transactionDone(tx);
  void done.catch(() => {});
  const store = tx.objectStore(STORE_NAME);
  const candidatePrefix = `${IMPORT_SPOOL_PREFIX}${transferId}:`;
  const nextPrefix = activeRecordPrefix(generation);
  let copied = 0;
  await new Promise<void>((resolve, reject) => {
    const cursorRequest = store.openCursor(prefixRange(candidatePrefix));
    cursorRequest.onerror = () =>
      reject(cursorRequest.error ?? new Error('IndexedDB cursor failed'));
    cursorRequest.onsuccess = () => {
      try {
        const cursor = cursorRequest.result;
        if (!cursor) {
          resolve();
          return;
        }
        if (typeof cursor.key !== 'string') {
          throw new Error('Invalid portable candidate key');
        }
        const activeKey = cursor.key.slice(candidatePrefix.length);
        parseKey(activeKey);
        store.put(cursor.value, `${nextPrefix}${activeKey}`);
        copied += 1;
        cursor.continue();
      } catch (error) {
        abortTransaction(tx);
        reject(error);
      }
    };
  });
  if (copied === 0) {
    abortTransaction(tx);
    throw new Error('Portable import candidate is empty');
  }
  await done;
}

async function switchActiveGeneration(
  db: IDBDatabase,
  expectedGeneration: string,
  nextGeneration: string
): Promise<void> {
  const tx = db.transaction(STORE_NAME, 'readwrite');
  const store = tx.objectStore(STORE_NAME);
  const storedGeneration = await request(store.get(ACTIVE_GENERATION_KEY));
  const current = storedGeneration ?? LEGACY_GENERATION;
  if (current !== expectedGeneration) {
    abortTransaction(tx);
    throw new Error('Secure-storage generation changed during import');
  }
  store.put(nextGeneration, ACTIVE_GENERATION_KEY);
  await transactionDone(tx);
}

async function putImportRecord(
  db: IDBDatabase,
  transferId: string,
  key: LogicalKey,
  value: Uint8Array
): Promise<void> {
  const tx = db.transaction(STORE_NAME, 'readwrite');
  tx.objectStore(STORE_NAME).put(
    value,
    `${IMPORT_SPOOL_PREFIX}${transferId}:${encodedKey(key)}`
  );
  await transactionDone(tx);
}

interface ParsedFrame {
  key: LogicalKey;
  valueLength: number;
}

/**
 * Strict bounded browser receiver for a portable-V1 archive.
 *
 * Records are validated and spooled under an import-owned prefix as their
 * complete bytes arrive. Active `s:` storage is never touched by this stage;
 * abort and restart can therefore discard the candidate without affecting the
 * installation selected before import.
 */
export class PortableWebImport {
  private readonly hash = sha256.create();
  private db: IDBDatabase | null;
  private lease: CrossTabLease | null;
  private pending = new Uint8Array(0);
  private stage:
    | 'header'
    | 'records'
    | 'digest'
    | 'validated'
    | 'failed'
    | 'closed' = 'header';
  private operationTail: Promise<void> = Promise.resolve();
  private queuedBytes = 0;
  private finishing = false;
  private installing = false;
  private closing = false;
  private closePromise: Promise<void> | null = null;
  private declaredRecordCount = 0;
  private declaredRecordBytes = 0;
  private parsedRecordCount = 0;
  private parsedRecordBytes = 0;
  private keypairSlot = 0;
  private blockNamespace = 0;
  private blockIndex = 0;
  private blockSlot = 0;
  private namespaceZeroBlocks = 0;
  private expectedDigest: Uint8Array | null = null;
  private totalReceived = 0;
  private digestVerified = false;
  private stagedGeneration: string | null = null;

  private constructor(
    db: IDBDatabase,
    lease: CrossTabLease,
    private readonly transferId: string,
    private readonly validators: PortableWebValidators,
    private readonly sourceGeneration: string
  ) {
    this.db = db;
    this.lease = lease;
  }

  static async begin(
    validators: PortableWebValidators,
    signal?: AbortSignal
  ): Promise<PortableWebImport> {
    const lease = await acquireExportLease(signal);
    let db: IDBDatabase | null = null;
    try {
      db = await openDatabase();
      await deleteSpools(db, IMPORT_SPOOL_PREFIX);
      await cleanupInactiveGenerations(db);
      const sourceGeneration = await readActiveGeneration(db);
      return new PortableWebImport(
        db,
        lease,
        randomTransferId(),
        validators,
        sourceGeneration
      );
    } catch (error) {
      db?.close();
      lease.release();
      await lease.completion;
      throw error;
    }
  }

  private append(chunk: Uint8Array): void {
    const nextLength = checkedAdd(this.pending.byteLength, chunk.byteLength);
    if (
      nextLength >
      MAX_KEYPAIR_VALUE_BYTES + FRAME_BYTES + MAX_TRANSFER_CHUNK_BYTES
    ) {
      throw new Error('Portable import record exceeds memory bound');
    }
    const next = new Uint8Array(nextLength);
    next.set(this.pending, 0);
    next.set(chunk, this.pending.byteLength);
    this.pending.fill(0);
    this.pending = next;
  }

  private consume(length: number): Uint8Array {
    const value = this.pending.slice(0, length);
    const remainder = this.pending.slice(length);
    this.pending.fill(0);
    this.pending = remainder;
    return value;
  }

  private parseHeader(bytes: Uint8Array): void {
    if (!equalBytes(bytes.subarray(0, MAGIC.byteLength), MAGIC)) {
      throw new Error('Invalid portable backup magic');
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (readPortableU64(view, 8) !== 1) {
      throw new Error('Unsupported portable backup version');
    }
    if (readPortableU64(view, 16) !== SESSION_COUNT) {
      throw new Error('Portable backup slot capacity does not match runtime');
    }
    this.declaredRecordCount = readPortableU64(view, 24);
    this.declaredRecordBytes = readPortableU64(view, 32);
    if (
      this.declaredRecordCount < SESSION_COUNT ||
      this.declaredRecordCount >
        Math.floor(this.declaredRecordBytes / (FRAME_BYTES + 4))
    ) {
      throw new Error('Invalid portable backup record count');
    }
    checkedAdd(
      checkedAdd(HEADER_BYTES, this.declaredRecordBytes),
      DIGEST_BYTES
    );
    this.hash.update(bytes);
    this.stage = 'records';
  }

  private parseFrame(bytes: Uint8Array): ParsedFrame {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const kind = bytes[0];
    const slot = bytes[1];
    const namespace = readPortableU64(view, 2);
    const blockIndex = readPortableU64(view, 10);
    const valueLength = readPortableU64(view, 18);
    if (kind === 0) {
      if (
        this.keypairSlot >= SESSION_COUNT ||
        slot !== this.keypairSlot ||
        namespace !== 0 ||
        blockIndex !== 0 ||
        valueLength < 4 ||
        valueLength > MAX_KEYPAIR_VALUE_BYTES
      ) {
        throw new Error('Non-canonical portable keypair record');
      }
      return { key: { kind: 'keypair', slot }, valueLength };
    }
    if (kind !== 1 || this.keypairSlot !== SESSION_COUNT) {
      throw new Error('Non-canonical portable record order');
    }
    if (valueLength !== BLOCK_BYTES || slot >= SESSION_COUNT) {
      throw new Error('Invalid portable block record');
    }
    if (
      this.blockNamespace === 0 &&
      this.blockSlot === 0 &&
      this.blockIndex > 0 &&
      namespace === 1 &&
      blockIndex === 0 &&
      slot === 0
    ) {
      this.blockNamespace = 1;
      this.blockIndex = 0;
    }
    if (
      namespace !== this.blockNamespace ||
      blockIndex !== this.blockIndex ||
      slot !== this.blockSlot
    ) {
      throw new Error('Non-canonical portable block order');
    }
    return {
      key: { kind: 'block', slot, namespace, blockIndex },
      valueLength,
    };
  }

  private advanceFrame(key: LogicalKey): void {
    this.parsedRecordCount += 1;
    if (key.kind === 'keypair') {
      this.keypairSlot += 1;
      return;
    }
    if (key.namespace === 0) this.namespaceZeroBlocks += 1;
    this.blockSlot += 1;
    if (this.blockSlot === SESSION_COUNT) {
      this.blockSlot = 0;
      this.blockIndex += 1;
    }
  }

  private async consumeAvailable(): Promise<void> {
    if (this.stage === 'header' && this.pending.byteLength >= HEADER_BYTES) {
      this.parseHeader(this.consume(HEADER_BYTES));
    }
    while (this.stage === 'records') {
      if (this.parsedRecordBytes === this.declaredRecordBytes) {
        if (
          this.parsedRecordCount !== this.declaredRecordCount ||
          this.keypairSlot !== SESSION_COUNT ||
          this.namespaceZeroBlocks === 0 ||
          this.blockSlot !== 0
        ) {
          throw new Error('Incomplete portable backup layout');
        }
        this.stage = 'digest';
        break;
      }
      if (this.pending.byteLength < FRAME_BYTES) break;
      if (this.parsedRecordCount >= this.declaredRecordCount) {
        throw new Error('Portable backup exceeds declared record count');
      }
      const frameBytes = this.pending.subarray(0, FRAME_BYTES);
      const parsed = this.parseFrame(frameBytes);
      const encodedLength = checkedAdd(FRAME_BYTES, parsed.valueLength);
      if (this.parsedRecordBytes + encodedLength > this.declaredRecordBytes) {
        throw new Error('Portable record exceeds declared section');
      }
      if (this.pending.byteLength < encodedLength) break;
      const record = this.consume(encodedLength);
      try {
        const value = record.subarray(FRAME_BYTES);
        if (parsed.key.kind === 'keypair') {
          this.validators.validateKeypair(value);
        } else {
          this.validators.validateBlock(value);
        }
        this.hash.update(record);
        if (!this.db) throw new Error('Portable import is closed');
        await putImportRecord(this.db, this.transferId, parsed.key, value);
        this.parsedRecordBytes += encodedLength;
        this.advanceFrame(parsed.key);
      } finally {
        record.fill(0);
      }
    }
    if (this.stage === 'digest' && this.pending.byteLength >= DIGEST_BYTES) {
      this.expectedDigest = this.consume(DIGEST_BYTES);
      this.stage = 'validated';
    }
    if (this.stage === 'validated' && this.pending.byteLength !== 0) {
      throw new Error('Portable backup has trailing bytes');
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  push(chunk: Uint8Array): Promise<void> {
    if (
      this.closing ||
      this.finishing ||
      this.stage === 'validated' ||
      this.stage === 'failed' ||
      this.stage === 'closed'
    ) {
      return Promise.reject(new Error('Portable import is not accepting data'));
    }
    if (
      !(chunk instanceof Uint8Array) ||
      chunk.byteLength === 0 ||
      chunk.byteLength > MAX_TRANSFER_CHUNK_BYTES
    ) {
      return Promise.reject(new Error('Invalid portable import chunk'));
    }
    if (this.queuedBytes + chunk.byteLength > MAX_QUEUED_IMPORT_BYTES) {
      return Promise.reject(
        new Error('Portable import requires sequential chunk backpressure')
      );
    }
    this.queuedBytes += chunk.byteLength;
    const ownedChunk = chunk.slice();
    return this.enqueue(async () => {
      if (this.closing || this.stage === 'failed') {
        ownedChunk.fill(0);
        this.queuedBytes -= ownedChunk.byteLength;
        throw new Error('Portable import is not accepting data');
      }
      try {
        this.totalReceived = checkedAdd(
          this.totalReceived,
          ownedChunk.byteLength
        );
        this.append(ownedChunk);
        await this.consumeAvailable();
      } catch (error) {
        this.stage = 'failed';
        this.pending.fill(0);
        this.pending = new Uint8Array(0);
        throw error;
      } finally {
        ownedChunk.fill(0);
        this.queuedBytes -= ownedChunk.byteLength;
      }
    });
  }

  finishValidation(): Promise<void> {
    if (this.closing || this.finishing) {
      return Promise.reject(new Error('Portable import is not accepting data'));
    }
    this.finishing = true;
    return this.enqueue(async () => {
      if (this.stage === 'failed') {
        throw new Error('Portable backup validation already failed');
      }
      if (this.stage !== 'validated' || !this.expectedDigest) {
        throw new Error('Portable backup is truncated');
      }
      const expectedTotal =
        HEADER_BYTES + this.declaredRecordBytes + DIGEST_BYTES;
      if (this.totalReceived !== expectedTotal) {
        throw new Error('Portable backup length does not match header');
      }
      const actualDigest = this.hash.digest();
      if (!equalBytes(actualDigest, this.expectedDigest)) {
        this.stage = 'failed';
        throw new Error('Portable backup checksum mismatch');
      }
      this.expectedDigest.fill(0);
      this.expectedDigest = null;
      this.digestVerified = true;
      this.pending.fill(0);
      this.db?.close();
      this.db = null;
      // Retain the cross-tab lease while the validated candidate awaits
      // password authorization/migration. Otherwise another tab could start a
      // transfer and reclaim this candidate before the all-at-once switch.
    });
  }

  install(): Promise<{ generation: string }> {
    if (
      !this.digestVerified ||
      this.closing ||
      this.installing ||
      this.stage !== 'validated'
    ) {
      return Promise.reject(new Error('Portable import is not validated'));
    }
    this.installing = true;
    const installation = this.enqueue(async () => {
      if (!this.db) this.db = await openDatabase();
      if (!navigator.locks) {
        throw new Error('This browser cannot safely install a backup');
      }
      const generation = this.stagedGeneration ?? randomTransferId();
      if (!this.stagedGeneration) {
        await stageCandidateGeneration(this.db, this.transferId, generation);
        this.stagedGeneration = generation;
      }
      await navigator.locks.request(
        INSTALLATION_FENCE_LOCK_NAME,
        { mode: 'exclusive' },
        async () => {
          if (!this.db) throw new Error('Portable import is closed');
          await switchActiveGeneration(
            this.db,
            this.sourceGeneration,
            generation
          );
        }
      );
      // The marker switch is already committed. Cleanup cannot roll it back;
      // restart cleanup removes any leftovers if quota/storage errors occur.
      await deletePrefix(
        this.db,
        `${IMPORT_SPOOL_PREFIX}${this.transferId}:`
      ).catch(() => {});
      if (this.sourceGeneration !== LEGACY_GENERATION) {
        await deletePrefix(
          this.db,
          activeRecordPrefix(this.sourceGeneration)
        ).catch(() => {});
      }
      this.db.close();
      this.db = null;
      this.stage = 'closed';
      const lease = this.lease;
      this.lease = null;
      lease?.release();
      if (lease) await lease.completion;
      return { generation };
    });
    void installation.catch(() => {
      this.installing = false;
    });
    return installation;
  }

  close(): Promise<void> {
    if (this.stage === 'closed') return Promise.resolve();
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    const closing = (async () => {
      await this.operationTail;
      // Installation may have completed while close waited. Its generation is
      // now active and must never be treated as an abort-owned staging prefix.
      if (this.stage === 'closed') return;
      let lease = this.lease;
      if (!lease) lease = await acquireExportLease();
      if (!this.db) this.db = await openDatabase();
      try {
        await deleteSpools(
          this.db,
          `${IMPORT_SPOOL_PREFIX}${this.transferId}:`
        );
        if (this.stagedGeneration) {
          await deletePrefix(
            this.db,
            activeRecordPrefix(this.stagedGeneration)
          );
        }
      } catch (error) {
        this.db.close();
        this.db = null;
        this.lease = lease;
        throw error;
      }
      this.pending.fill(0);
      this.expectedDigest?.fill(0);
      this.expectedDigest = null;
      this.db.close();
      this.db = null;
      this.stage = 'closed';
      lease.release();
      await lease.completion;
      this.lease = null;
    })();
    this.closePromise = closing;
    void closing.catch(() => {
      if (this.closePromise === closing) this.closePromise = null;
    });
    return closing;
  }
}
