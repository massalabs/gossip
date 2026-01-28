/**
 * Storage Abstraction Layer
 *
 * This module provides a clean repository-pattern abstraction that supports
 * multiple pluggable storage backends:
 *
 * 1. **DexieBackend** - IndexedDB via Dexie (browser only, no encryption at rest)
 * 2. **EncryptedSqliteBackend** - SQLite with AES-256-SIV encryption and plausible deniability
 *
 * Users can also inject custom backends (Postgres, MongoDB, etc.) by implementing
 * the IStorageBackend interface.
 *
 * @example
 * ```typescript
 * import { StorageManager } from './storage';
 *
 * // Option 1: Use encrypted backend (auto-detects browser vs Node.js)
 * const storage = await StorageManager.create({
 *   type: 'encrypted-sqlite',
 *   password: 'user-password'
 * });
 *
 * // Option 2: Use Dexie backend (browser only)
 * const storage = await StorageManager.create({ type: 'dexie' });
 *
 * // Option 3: Inject custom backend
 * const storage = await StorageManager.create({ backend: myCustomBackend });
 *
 * // Access repositories
 * const contacts = await storage.contacts.getByOwner(userId);
 * const messages = await storage.messages.getByContact(userId, contactId);
 *
 * // Subscribe to changes
 * storage.contacts.observeByOwner(userId).subscribe(contacts => {
 *   console.log('Contacts updated:', contacts);
 * });
 *
 * // Lock/unlock for encrypted backends
 * await storage.lock();
 * await storage.unlock('password');
 * ```
 */

// ============ Main API ============
export { StorageManager, type StorageManagerOptions } from './StorageManager';

// ============ Interfaces ============
export type {
  // Backend interface
  IStorageBackend,
  StorageBackendOptions,
  BackendType,

  // Low-level adapter interface
  IStorageAdapter,
  QueryFilter,
  QueryOptions,

  // Runtime adapter interface
  IRuntimeAdapter,
  RuntimeCapabilities,
  RuntimeEvent,
  RuntimeAdapterFactory,

  // Repository interfaces
  IRepository,
  IBulkRepository,
  IContactRepository,
  IMessageRepository,
  IDiscussionRepository,
  IUserProfileRepository,
  IPendingMessageRepository,
  IPendingAnnouncementRepository,
  IActiveSeekerRepository,
} from './interfaces';

export { isSqlAdapter, isDocumentAdapter } from './interfaces';

// ============ Models ============
export type {
  Contact,
  Message,
  UserProfile,
  Discussion,
  PendingEncryptedMessage,
  PendingAnnouncement,
  ActiveSeeker,
  Persisted,
  CreateInput,
  UpdateInput,
} from './models';

export {
  MessageDirection,
  MessageStatus,
  MessageType,
  DiscussionStatus,
  DiscussionDirection,
  type AuthMethod,
} from './models';

// ============ Observable ============
export type { Observable, Subscription } from './base/Observable';
export {
  Subject,
  BehaviorSubject,
  fromDexieLiveQuery,
  combineLatest,
  map,
} from './base/Observable';

// ============ Runtime ============
export {
  detectCapabilities,
  getBestRuntimeType,
  supportsEncryptedSqlite,
  supportsDexie,
  getRuntimeDescription,
  createRuntime,
  BrowserWorkerRuntime,
  NodeRuntime,
  NodeEncryptedRuntime,
  type CreateRuntimeOptions,
  type NodeRuntimeOptions,
  type NodeEncryptedRuntimeOptions,
} from './runtime';

// ============ Backends ============

// Dexie backend
export { DexieBackend, type DexieBackendOptions } from './backends/dexie';

// Encrypted SQLite backend
export {
  EncryptedSqliteBackend,
  type EncryptedSqliteBackendOptions,
  StorageWorkerClient,
  getStorageWorkerClient,
  resetStorageWorkerClient,
  type WorkerStatus,
  type SqlResult,
  type VizEvent,
} from './backends/encrypted';

// ============ Schema Utilities ============
export {
  CREATE_TABLES_SQL,
  dateToSql,
  sqlToDate,
  jsonToSql,
  sqlToJson,
  boolToSql,
  sqlToBool,
  blobToSql,
  sqlToBlob,
} from './schema/sqlite';

// ============ Compatibility ============
export { DatabaseAdapter } from './compat';
