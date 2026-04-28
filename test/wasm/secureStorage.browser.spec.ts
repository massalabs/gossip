import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import initSecureStorageWasm, {
  allocateSession,
  clearNamespace,
  closeDatabase,
  execSql,
  flushEncrypted,
  idbHasData,
  initSecureStorage,
  lockSession,
  namespaceDataLength,
  openDatabase,
  provisionStorage,
  readNamespaceData,
  unlockSession,
  writeNamespaceData,
} from '../../gossip-sdk/src/assets/generated/wasm-secureStorage';

const DEFAULT_NAMESPACE = 0;
const DOMAIN = `secure-storage-browser-tests-${Date.now()}`;
const PASSWORD_A = new Uint8Array([1, 2, 3, 4]);
const PASSWORD_B = new Uint8Array([5, 6, 7, 8]);

function rowsOf(sql: string): Array<Array<unknown>> {
  return execSql(sql, []).rows as Array<Array<unknown>>;
}

describe('secure-storage wasm browser integration', () => {
  beforeAll(async () => {
    await initSecureStorageWasm();
    await initSecureStorage(DOMAIN, 'idb');
  });

  beforeEach(() => {
    closeDatabase();
    provisionStorage();
  });

  it('keeps SQLite handles session-bound across implicit session switches', () => {
    allocateSession(0, PASSWORD_A);
    openDatabase();
    execSql('CREATE TABLE session_data (value TEXT)', []);
    execSql('INSERT INTO session_data (value) VALUES (?)', ['session-a']);

    expect(rowsOf('SELECT value FROM session_data')).toEqual([['session-a']]);

    allocateSession(1, PASSWORD_B);
    openDatabase();

    expect(() => rowsOf('SELECT value FROM session_data')).toThrow();

    execSql('CREATE TABLE session_data (value TEXT)', []);
    execSql('INSERT INTO session_data (value) VALUES (?)', ['session-b']);
    expect(rowsOf('SELECT value FROM session_data')).toEqual([['session-b']]);

    expect(unlockSession(PASSWORD_A)).toBe(true);
    openDatabase();
    expect(rowsOf('SELECT value FROM session_data')).toEqual([['session-a']]);
  });

  it('rejects generic namespace APIs for the SQLite namespace', () => {
    allocateSession(0, PASSWORD_A);

    expect(() =>
      writeNamespaceData(DEFAULT_NAMESPACE, 0, new Uint8Array([1]))
    ).toThrow(/DEFAULT_NAMESPACE/);
    expect(() => readNamespaceData(DEFAULT_NAMESPACE, 0, 1)).toThrow(
      /DEFAULT_NAMESPACE/
    );
    expect(() => namespaceDataLength(DEFAULT_NAMESPACE)).toThrow(
      /DEFAULT_NAMESPACE/
    );
    expect(() => clearNamespace(DEFAULT_NAMESPACE)).toThrow(
      /DEFAULT_NAMESPACE/
    );
  });

  it('opens SQLite, executes SQL, and flushes encrypted data to IndexedDB', async () => {
    allocateSession(0, PASSWORD_A);
    openDatabase();
    execSql('CREATE TABLE smoke (id INTEGER PRIMARY KEY, value TEXT)', []);
    execSql('INSERT INTO smoke (value) VALUES (?)', ['persisted']);

    expect(rowsOf('SELECT value FROM smoke')).toEqual([['persisted']]);

    await flushEncrypted();

    expect(await idbHasData()).toBe(true);
    lockSession();
  });
});
