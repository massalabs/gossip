import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import fixtureUrl from '../../wasm/secure-storage/tests/fixtures/portable-v1-minimal.gossipbackup?url';
import initSecureStorageWasm from '../../gossip-sdk/src/assets/generated/wasm-secureStorage/secureStorage.js';
import secureStorageWasmUrlRaw from '../../gossip-sdk/src/assets/generated/wasm-secureStorage/secureStorage_bg.wasm?url';
import {
  PortableWebExport,
  PortableWebImport,
  portableImportInstalledWeb,
} from '../../gossip-sdk/src/db/secure-storage-portable-web';

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

async function put(key: string, value: unknown): Promise<void> {
  const db = await openDatabase();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  tx.objectStore(STORE_NAME).put(value, key);
  await transactionDone(tx);
  db.close();
}

async function getValue(key: string): Promise<unknown> {
  const db = await openDatabase();
  const tx = db.transaction(STORE_NAME, 'readonly');
  const value = await request(tx.objectStore(STORE_NAME).get(key));
  await transactionDone(tx);
  db.close();
  return value;
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

async function expandedFixture(blockCount: number): Promise<Uint8Array> {
  const original = await fixture();
  const parsed = records(original);
  const frames: Uint8Array[] = [];
  const appendFrame = (
    kind: number,
    slot: number,
    namespace: number,
    blockIndex: number,
    value: Uint8Array
  ) => {
    const frame = new Uint8Array(26 + value.byteLength);
    const view = new DataView(frame.buffer);
    frame[0] = kind;
    frame[1] = slot;
    view.setBigUint64(2, BigInt(namespace), false);
    view.setBigUint64(10, BigInt(blockIndex), false);
    view.setBigUint64(18, BigInt(value.byteLength), false);
    frame.set(value, 26);
    frames.push(frame);
  };
  for (let slot = 0; slot < 3; slot += 1) {
    appendFrame(0, slot, 0, 0, parsed[slot][1]);
  }
  for (let blockIndex = 0; blockIndex < blockCount; blockIndex += 1) {
    for (let slot = 0; slot < 3; slot += 1) {
      appendFrame(1, slot, 0, blockIndex, parsed[3 + slot][1]);
    }
  }
  const sectionBytes = frames.reduce(
    (total, frame) => total + frame.byteLength,
    0
  );
  const output = new Uint8Array(40 + sectionBytes + 32);
  output.set(original.subarray(0, 40));
  const header = new DataView(output.buffer);
  header.setBigUint64(24, BigInt(frames.length), false);
  header.setBigUint64(32, BigInt(sectionBytes), false);
  let offset = 40;
  for (const frame of frames) {
    output.set(frame, offset);
    offset += frame.byteLength;
  }
  output.set(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', output.subarray(0, offset))
    ),
    offset
  );
  return output;
}

const validators = {
  validateKeypair(value: Uint8Array) {
    expect([98_340, 98_352]).toContain(value.byteLength);
  },
  validateBlock(value: Uint8Array) {
    expect(value.byteLength).toBe(65_536);
  },
};

async function stageOuterMigration(transfer: PortableWebImport): Promise<void> {
  await transfer.beginOuterMigration('portable-web-test');
  await transfer.finalizeOuterMigration();
}

beforeAll(async () => {
  const wasmUrl = new URL(secureStorageWasmUrlRaw, window.location.href).href;
  await initSecureStorageWasm({ module_or_path: wasmUrl });
});

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

  it('aborts snapshot staging and removes partial spool records', async () => {
    const expected = await fixture();
    await seed(records(expected));
    const controller = new AbortController();
    const cancellingValidators = {
      ...validators,
      validateKeypair(value: Uint8Array) {
        validators.validateKeypair(value);
        controller.abort();
      },
    };

    await expect(
      PortableWebExport.begin(cancellingValidators, controller.signal)
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect((await allKeys()).some(key => String(key).startsWith('x:'))).toBe(
      false
    );
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

describe('PortableWebImport', () => {
  beforeEach(async () => {
    await seed([]);
  });

  it('validates and spools a canonical archive without touching active data', async () => {
    const expected = await fixture();
    await seed([['s:0:sentinel', new Uint8Array([7])]]);
    const transfer = await PortableWebImport.begin(validators);
    for (let offset = 0; offset < expected.byteLength; offset += 71_111) {
      await transfer.push(expected.slice(offset, offset + 71_111));
    }
    await transfer.finishValidation();

    const keys = (await allKeys()).map(String);
    expect(keys).toContain('s:0:sentinel');
    expect(
      keys.filter(key => key.startsWith('x:portable-import:'))
    ).toHaveLength(records(expected).length);

    await transfer.close();
    expect(
      (await allKeys()).map(String).filter(key => key.startsWith('s:'))
    ).toEqual(['s:0:sentinel']);
  });

  it('streams validated preview records without staging or exposing a match', async () => {
    const expected = await fixture();
    await put('s:0:sentinel', new Uint8Array([7]));
    const transfer = await PortableWebImport.begin(validators);
    await transfer.push(expected);
    await transfer.finishValidation();
    let borrowedKeypairs: Uint8Array[] = [];
    let borrowedBlock: Uint8Array | null = null;
    const coordinates: Array<[number, number, number]> = [];

    await expect(
      transfer.previewCandidate(
        keypairs => {
          borrowedKeypairs = keypairs;
          return true;
        },
        (slot, namespace, blockIndex, value) => {
          borrowedBlock ??= value;
          coordinates.push([slot, namespace, blockIndex]);
        }
      )
    ).resolves.toBe(true);

    expect(borrowedKeypairs).toHaveLength(3);
    expect(
      borrowedKeypairs.every(keypair => keypair.every(byte => byte === 0))
    ).toBe(true);
    expect(borrowedBlock).not.toBeNull();
    expect(borrowedBlock!.every(byte => byte === 0)).toBe(true);
    expect(coordinates).toEqual(
      records(expected)
        .filter(([key]) => key.includes(':n:'))
        .map(([key]) => {
          const match = /^s:(\d):n:(\d):b:(\d+)$/.exec(key)!;
          return [Number(match[1]), Number(match[2]), Number(match[3])];
        })
    );
    expect(await getValue('m:active-generation')).toBeUndefined();
    expect(await getValue('s:0:sentinel')).toEqual(new Uint8Array([7]));
    expect(
      (await allKeys()).some(key =>
        String(key).startsWith('x:portable-import:')
      )
    ).toBe(true);
    await transfer.close();
  });

  it('streams double-digit block indexes in numeric order', async () => {
    const expected = await expandedFixture(12);
    const transfer = await PortableWebImport.begin(validators);
    for (let offset = 0; offset < expected.byteLength; offset += 256 * 1024) {
      await transfer.push(expected.slice(offset, offset + 256 * 1024));
    }
    await transfer.finishValidation();
    const indexes: number[] = [];

    await expect(
      transfer.previewCandidate(
        () => true,
        (_slot, _namespace, blockIndex) => indexes.push(blockIndex)
      )
    ).resolves.toBe(true);
    expect(indexes).toEqual(
      Array.from({ length: 12 }, (_, blockIndex) =>
        Array.from({ length: 3 }, () => blockIndex)
      ).flat()
    );
    await transfer.close();
  });

  it('does not stream candidate blocks after generic authentication failure', async () => {
    const expected = await fixture();
    const transfer = await PortableWebImport.begin(validators);
    await transfer.push(expected);
    await transfer.finishValidation();
    let blockCalls = 0;

    await expect(
      transfer.previewCandidate(
        () => false,
        () => {
          blockCalls += 1;
        }
      )
    ).resolves.toBe(false);
    expect(blockCalls).toBe(0);
    await transfer.close();
  });

  it('serializes concurrently submitted chunks in admission order', async () => {
    const expected = await fixture();
    const transfer = await PortableWebImport.begin(validators);
    const pushes: Promise<void>[] = [];
    for (let offset = 0; offset < expected.byteLength; offset += 31_337) {
      pushes.push(transfer.push(expected.slice(offset, offset + 31_337)));
    }
    await Promise.all(pushes);
    await transfer.finishValidation();
    await transfer.close();
  });

  it('drains admitted work before abort cleanup and rejects later writes', async () => {
    const expected = await fixture();
    const transfer = await PortableWebImport.begin(validators);
    const push = transfer.push(expected);
    const close = transfer.close();
    await expect(push).rejects.toThrow('Portable import is not accepting data');
    await close;
    expect((await allKeys()).some(key => String(key).startsWith('x:'))).toBe(
      false
    );
  });

  it('bounds concurrently queued chunk ownership', async () => {
    const transfer = await PortableWebImport.begin(validators);
    const first = transfer.push(new Uint8Array(1024 * 1024));
    const second = transfer.push(new Uint8Array(1024 * 1024));
    await expect(transfer.push(new Uint8Array([1]))).rejects.toThrow(
      'Portable import requires sequential chunk backpressure'
    );
    await Promise.allSettled([first, second]);
    await transfer.close();
  });

  it('rejects records beyond the declared count before spooling them', async () => {
    const bytes = await fixture();
    new DataView(bytes.buffer).setBigUint64(24, 3n, false);
    const transfer = await PortableWebImport.begin(validators);
    await expect(transfer.push(bytes)).rejects.toThrow(
      'Portable backup exceeds declared record count'
    );
    expect(
      (await allKeys()).filter(key =>
        String(key).startsWith('x:portable-import:')
      )
    ).toHaveLength(3);
    await transfer.close();
  });

  it('rejects a checksum mismatch and keeps cleanup retryable', async () => {
    const bytes = await fixture();
    bytes[bytes.byteLength - 1] ^= 1;
    const transfer = await PortableWebImport.begin(validators);
    await transfer.push(bytes);
    await expect(transfer.finishValidation()).rejects.toThrow(
      'Portable backup checksum mismatch'
    );
    expect(
      (await allKeys()).some(key =>
        String(key).startsWith('x:portable-import:')
      )
    ).toBe(true);
    await transfer.close();
    expect((await allKeys()).some(key => String(key).startsWith('x:'))).toBe(
      false
    );
  });

  it('rejects non-canonical coordinates before accepting the record', async () => {
    const bytes = await fixture();
    bytes[41] = 1;
    const transfer = await PortableWebImport.begin(validators);
    await expect(transfer.push(bytes)).rejects.toThrow(
      'Non-canonical portable keypair record'
    );
    await expect(transfer.push(new Uint8Array([1]))).rejects.toThrow(
      'Portable import is not accepting data'
    );
    await transfer.close();
  });

  it('rejects trailing and truncated archives', async () => {
    const expected = await fixture();
    const trailing = await PortableWebImport.begin(validators);
    const extended = new Uint8Array(expected.byteLength + 1);
    extended.set(expected);
    await expect(trailing.push(extended)).rejects.toThrow(
      'Portable backup has trailing bytes'
    );
    await trailing.close();

    const truncated = await PortableWebImport.begin(validators);
    await truncated.push(expected.subarray(0, expected.byteLength - 1));
    await expect(truncated.finishValidation()).rejects.toThrow(
      'Portable backup is truncated'
    );
    await truncated.close();
  });

  it('atomically installs a validated candidate and rotates its generation', async () => {
    const expected = await fixture();
    await put('s:0:sentinel', new Uint8Array([7]));
    const transfer = await PortableWebImport.begin(validators);
    await transfer.push(expected);
    await transfer.finishValidation();
    await stageOuterMigration(transfer);

    const { generation } = await transfer.install();
    expect(generation).toMatch(/^[0-9a-f]{32}$/);
    expect(await getValue('m:active-generation')).toBe(generation);
    expect(await getValue('m:portable-import-installed-v1')).toBe(true);
    await expect(portableImportInstalledWeb()).resolves.toBe(true);
    // The marker switch fences stale tabs before legacy records are removed.
    expect(await getValue('s:0:sentinel')).toBeUndefined();
    const installedRecords: [string, Uint8Array][] = [];
    for (const [key, value] of records(expected)) {
      const installed = (await getValue(
        `g:${generation}:${key}`
      )) as Uint8Array;
      expect(installed).not.toEqual(value);
      if (key.endsWith(':kp')) {
        expect(new DataView(installed.buffer).getUint32(0, false)).toBe(1);
      } else {
        expect(installed).toHaveLength(65_536);
      }
      installedRecords.push([key, installed]);
    }
    expect((await allKeys()).some(key => String(key).startsWith('x:'))).toBe(
      false
    );

    await put('s:0:n:0:b:0', new Uint8Array(65_536));
    const exported = await PortableWebExport.begin(validators);
    const chunks: Uint8Array[] = [];
    while (true) {
      const chunk = await exported.read(256 * 1024);
      if (chunk === null) break;
      chunks.push(chunk);
    }
    await exported.close();
    const roundTrip = new Uint8Array(
      chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
    );
    let offset = 0;
    for (const chunk of chunks) {
      roundTrip.set(chunk, offset);
      offset += chunk.byteLength;
    }
    expect(records(roundTrip)).toEqual(installedRecords);
  });

  it('does not delete an active generation when abort races installation', async () => {
    const expected = await fixture();
    const transfer = await PortableWebImport.begin(validators);
    await transfer.push(expected);
    await transfer.finishValidation();
    await stageOuterMigration(transfer);

    const installation = transfer.install();
    const close = transfer.close();
    const { generation } = await installation;
    await close;
    expect(await getValue('m:active-generation')).toBe(generation);
    const installedKeypair = (await getValue(
      `g:${generation}:s:0:kp`
    )) as Uint8Array;
    expect(installedKeypair).not.toEqual(records(expected)[0][1]);
    expect(new DataView(installedKeypair.buffer).getUint32(0, false)).toBe(1);
  });

  it('releases the export lease when the final installation transaction fails', async () => {
    const expected = await fixture();
    const transfer = await PortableWebImport.begin(validators);
    await transfer.push(expected);
    await transfer.finishValidation();
    await stageOuterMigration(transfer);

    const originalTransaction = IDBDatabase.prototype.transaction;
    let abortNextWrite = true;
    const transactionSpy = vi
      .spyOn(IDBDatabase.prototype, 'transaction')
      .mockImplementation(function (storeNames, mode, options) {
        const transaction = originalTransaction.call(
          this,
          storeNames,
          mode,
          options
        );
        if (abortNextWrite && mode === 'readwrite') {
          abortNextWrite = false;
          queueMicrotask(() => transaction.abort());
        }
        return transaction;
      });

    try {
      await expect(transfer.install()).rejects.toBeDefined();
    } finally {
      transactionSpy.mockRestore();
    }

    const installedProbe = portableImportInstalledWeb();
    try {
      const outcome = await Promise.race([
        installedProbe.then(value => ({ settled: true, value })),
        new Promise<{ settled: false }>(resolve =>
          setTimeout(() => resolve({ settled: false }), 100)
        ),
      ]);
      expect(outcome).toEqual({ settled: true, value: false });
    } finally {
      await transfer.close();
      await installedProbe;
    }
  });

  it('rejects a stale candidate generation without changing active storage', async () => {
    const expected = await fixture();
    await put('s:0:sentinel', new Uint8Array([7]));
    const transfer = await PortableWebImport.begin(validators);
    await transfer.push(expected);
    await transfer.finishValidation();
    await stageOuterMigration(transfer);
    await put('m:active-generation', 'another-generation');

    await expect(transfer.install()).rejects.toThrow(
      'Secure-storage generation changed during import'
    );
    expect(await getValue('s:0:sentinel')).toEqual(new Uint8Array([7]));
    expect(
      (await allKeys()).some(key =>
        String(key).startsWith('x:portable-import:')
      )
    ).toBe(true);
    await transfer.close();
  });

  it('reclaims interrupted import candidates during startup cleanup', async () => {
    await seed([
      ['x:portable-import:stale:s:0:kp', new Uint8Array([1, 2, 3])],
      ['g:0123456789abcdef0123456789abcdef:s:0:kp', new Uint8Array([4])],
    ]);
    await PortableWebExport.cleanupInterrupted();
    const keys = (await allKeys()).map(String);
    expect(keys.some(key => key.startsWith('x:'))).toBe(false);
    expect(keys.some(key => key.startsWith('g:'))).toBe(false);
  });
});
