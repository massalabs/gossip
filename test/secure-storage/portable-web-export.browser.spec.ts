import { afterEach, describe, expect, it } from 'vitest';
import fixtureUrl from '../../wasm/secure-storage/tests/fixtures/portable-v1-minimal.gossipbackup?url';
import { PortableWebExport } from '../../gossip-sdk/src/db/secure-storage-portable-web';

const DB_NAME = 'secure_storage';
const STORE_NAME = 'blocks';

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
    tx.onerror = () => reject(tx.error);
  });
}

async function deleteDatabase(): Promise<void> {
  await request(indexedDB.deleteDatabase(DB_NAME));
}

async function openDatabase(): Promise<IDBDatabase> {
  const req = indexedDB.open(DB_NAME, 1);
  req.onupgradeneeded = () => req.result.createObjectStore(STORE_NAME);
  return request(req);
}

function readU64(view: DataView, offset: number): number {
  return Number(view.getBigUint64(offset, false));
}

function records(bytes: Uint8Array): [string, Uint8Array][] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sectionLength = readU64(view, 32);
  const end = 40 + sectionLength;
  const out: [string, Uint8Array][] = [];
  let offset = 40;
  while (offset < end) {
    const kind = bytes[offset];
    const slot = bytes[offset + 1];
    const namespace = readU64(view, offset + 2);
    const block = readU64(view, offset + 10);
    const valueLength = readU64(view, offset + 18);
    const value = bytes.slice(offset + 26, offset + 26 + valueLength);
    const key =
      kind === 0 ? `s:${slot}:kp` : `s:${slot}:n:${namespace}:b:${block}`;
    out.push([key, value]);
    offset += 26 + valueLength;
  }
  return out;
}

async function seed(entries: [string, Uint8Array][]): Promise<void> {
  const db = await openDatabase();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  const store = tx.objectStore(STORE_NAME);
  for (const [key, value] of entries) store.put(value, key);
  await transactionDone(tx);
  db.close();
}

async function put(key: string, value: Uint8Array): Promise<void> {
  const db = await openDatabase();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  tx.objectStore(STORE_NAME).put(value, key);
  await transactionDone(tx);
  db.close();
}

async function allKeys(): Promise<IDBValidKey[]> {
  const db = await openDatabase();
  const tx = db.transaction(STORE_NAME, 'readonly');
  const keys = await request(tx.objectStore(STORE_NAME).getAllKeys());
  await transactionDone(tx);
  db.close();
  return keys;
}

async function fixture(): Promise<Uint8Array> {
  return new Uint8Array(await (await fetch(fixtureUrl)).arrayBuffer());
}

const validators = {
  validateKeypair(value: Uint8Array) {
    expect(value.byteLength).toBe(98_340);
  },
  validateBlock(value: Uint8Array) {
    expect(value.byteLength).toBe(65_536);
  },
};

afterEach(async () => {
  await deleteDatabase();
});

describe('PortableWebExport', () => {
  it('streams the frozen canonical fixture exactly with bounded chunks', async () => {
    const expected = await fixture();
    await seed(records(expected));
    const transfer = await PortableWebExport.begin(validators);
    const chunks: Uint8Array[] = [];
    while (true) {
      const chunk = await transfer.read(37_123);
      if (chunk === null) break;
      expect(chunk.byteLength).toBeLessThanOrEqual(37_123);
      chunks.push(chunk);
    }
    await transfer.close();

    const actual = new Uint8Array(
      chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
    );
    let offset = 0;
    for (const chunk of chunks) {
      actual.set(chunk, offset);
      offset += chunk.byteLength;
    }
    expect(actual).toEqual(expected);
    expect(transfer.totalBytes).toBe(expected.byteLength);
    expect((await allKeys()).some(key => String(key).startsWith('x:'))).toBe(
      false
    );
  });

  it('streams its coherent spool even if active records change afterward', async () => {
    const expected = await fixture();
    await seed(records(expected));
    const transfer = await PortableWebExport.begin(validators);
    await put('s:0:n:0:b:0', new Uint8Array(65_536));

    const chunks: Uint8Array[] = [];
    while (true) {
      const chunk = await transfer.read(256 * 1024);
      if (chunk === null) break;
      chunks.push(chunk);
    }
    await transfer.close();
    const actual = new Uint8Array(
      chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
    );
    let offset = 0;
    for (const chunk of chunks) {
      actual.set(chunk, offset);
      offset += chunk.byteLength;
    }
    expect(actual).toEqual(expected);
  });

  it('reclaims an interrupted export spool under the cross-tab lease', async () => {
    const expected = await fixture();
    await seed(records(expected));
    await put('x:portable-export:stale:s:0:kp', new Uint8Array([1, 2, 3]));

    await PortableWebExport.cleanupInterrupted();

    expect((await allKeys()).some(key => String(key).startsWith('x:'))).toBe(
      false
    );
  });

  it('rejects unknown physical records before producing output', async () => {
    const expected = await fixture();
    const entries = records(expected);
    entries.push(['s:9:kp', new Uint8Array([1])]);
    await seed(entries);
    await expect(PortableWebExport.begin(validators)).rejects.toThrow(
      'Invalid secure-storage key'
    );
    expect((await allKeys()).some(key => String(key).startsWith('x:'))).toBe(
      false
    );
  });

  it('rejects unequal slot coordinates', async () => {
    const expected = await fixture();
    const entries = records(expected).filter(([key]) => key !== 's:2:n:0:b:0');
    await seed(entries);
    await expect(PortableWebExport.begin(validators)).rejects.toThrow(
      'Unequal secure-storage slot layout'
    );
    expect((await allKeys()).some(key => String(key).startsWith('x:'))).toBe(
      false
    );
  });
});
