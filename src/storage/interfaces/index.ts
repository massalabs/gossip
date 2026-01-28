/**
 * Storage interfaces - contracts for the storage abstraction layer
 */

// Repository interfaces
export type {
  IRepository,
  IBulkRepository,
  IContactRepository,
  IMessageRepository,
  IDiscussionRepository,
  IUserProfileRepository,
  IPendingMessageRepository,
  IPendingAnnouncementRepository,
  IActiveSeekerRepository,
} from './repositories';

// Backend interface
export type {
  IStorageBackend,
  StorageBackendOptions,
  BackendType,
} from './IStorageBackend';

// Low-level adapter interface
export type {
  IStorageAdapter,
  QueryFilter,
  QueryOptions,
} from './IStorageAdapter';
export { isSqlAdapter, isDocumentAdapter } from './IStorageAdapter';

// Runtime adapter interface
export type {
  IRuntimeAdapter,
  RuntimeCapabilities,
  RuntimeEvent,
  RuntimeAdapterFactory,
} from './IRuntimeAdapter';
