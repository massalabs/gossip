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

async function acquireExportLease(): Promise<CrossTabLease> {
  if (!navigator.locks) {
    throw new Error('This browser cannot safely coordinate backup export');
  }
  let acquired!: () => void;
  let release!: () => void;
  const acquiredPromise = new Promise<void>(resolve => {
    acquired = resolve;
  });
  const hold = new Promise<void>(resolve => {
    release = resolve;
  });
  const completion = navigator.locks.request<void>(
    EXPORT_LOCK_NAME,
    { mode: 'exclusive' },
    async () => {
      acquired();
      await hold;
    }
  );
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

async function inspectAndSnapshotLayout(
  db: IDBDatabase,
  transferId: string,
  validators: PortableWebValidators
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
  const tx = db.transaction(STORE_NAME, 'readwrite');
  const store = tx.objectStore(STORE_NAME);
  const prefix = spoolPrefix(transferId);
  let layout: Layout | null = null;
  const done = transactionDone(tx);
  // The cursor path reports the more specific validation error. Attach an
  // abort handler immediately so that transaction rejection is not unhandled
  // when validation intentionally aborts before the later `await done`.
  void done.catch(() => {});
  await new Promise<void>((resolve, reject) => {
    const cursorRequest = store.openCursor(
      IDBKeyRange.bound('s:', 's;', false, true)
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
        const key = parseKey(cursor.key);
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
        tx.abort();
        reject(error);
      }
    };
  });
  await done;
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
    } finally {
      db?.close();
      lease.release();
      await lease.completion;
    }
  }

  static async begin(
    validators: PortableWebValidators
  ): Promise<PortableWebExport> {
    const lease = await acquireExportLease();
    let db: IDBDatabase | null = null;
    try {
      db = await openDatabase();
      await deleteSpools(db, EXPORT_SPOOL_PREFIX);
      const transferId = randomTransferId();
      const layout = await inspectAndSnapshotLayout(db, transferId, validators);
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
      maxBytes > 1024 * 1024
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
