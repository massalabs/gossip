/**
 * Shared secure-storage constants (namespaces + session count).
 *
 * Each `(session, namespace)` pair owns an independent block stream
 * inside the Rust `BlockStorage` trait. Keeping the constants in this
 * dedicated module lets both the main thread (`sqlite.ts`) and the
 * worker (`secure-storage-worker.ts`) import them without pulling in
 * the worker's browser-only WASM bindings at parse time.
 */

/**
 * Number of session slots maintained by the Rust core (real + decoys).
 * Must stay in sync with `SESSION_COUNT` in `wasm/secure-storage/src/
 * constants.rs`. Used by the SDK to validate `slot` parameters before
 * crossing the WASM boundary, where an invalid index surfaces as an
 * opaque "invalid parameter" error.
 */
export const SESSION_COUNT = 3;

/**
 * IndexedDB database name used by the WASM secure-storage backend.
 * Must stay in sync with `DB_NAME` in
 * `wasm/secure-storage/src/vfs/idb_storage.rs`. Tests use it to
 * `indexedDB.deleteDatabase` between cases; mismatching the name
 * silently turns the cleanup into a no-op (no error is raised when
 * deleting a database that does not exist), leaving stale ciphertext
 * for the next test to decrypt as garbage.
 */
export const SECURE_STORAGE_IDB_NAME = 'secure_storage';

// Single source of truth for namespace IDs. `COVER_TRAFFIC_NAMESPACES` is
// derived via Object.values so adding a field here automatically enrolls
// the new namespace in cover-traffic rerandomization — forgetting to do so
// would freeze the namespace's blocks across dummy slots and create a
// real-vs-cover distinguisher (PD regression).
const NAMESPACES = {
  SQL: 0,
  SESSION_BLOB: 1,
} as const;

export const SQL_NAMESPACE = NAMESPACES.SQL;
export const SESSION_BLOB_NAMESPACE = NAMESPACES.SESSION_BLOB;

export const COVER_TRAFFIC_NAMESPACES = Object.values(NAMESPACES);
