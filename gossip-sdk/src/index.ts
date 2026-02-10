/**
 * Gossip SDK
 *
 * Main entry point for the Gossip SDK.
 * Works in both browser and Node.js environments.
 *
 * WASM is loaded via the web target build with runtime detection:
 * - Browser: init() uses import.meta.url + fetch
 * - Node.js / Jiti: init(bytes) reads the .wasm file from disk
 *
 * @example
 * ```typescript
 * import { gossipSdk } from '@massalabs/gossip-sdk';
 *
 * await gossipSdk.init({ db, protocolBaseUrl: 'https://api.example.com' });
 * await gossipSdk.openSession({ mnemonic: '...' });
 * await gossipSdk.messages.send(contactId, 'Hello!');
 * ```
 *
 * @packageDocumentation
 */

// ─────────────────────────────────────────────────────────────────────────────
// SDK Singleton - Primary API
// ─────────────────────────────────────────────────────────────────────────────
export { gossipSdk, GossipSdkImpl } from './gossipSdk.js';
export type {
  GossipSdkInitOptions,
  OpenSessionOptions,
  SdkEventType,
  SdkEventHandlers,
} from './gossipSdk.js';

// SDK Events
export type { GossipSdkEvents } from './types/events.js';

// Services
export { AuthService } from './services/auth.js';
export type { PublicKeyResult } from './services/auth.js';
export {
  getPublicKeyErrorMessage,
  PUBLIC_KEY_NOT_FOUND_ERROR,
  PUBLIC_KEY_NOT_FOUND_MESSAGE,
  FAILED_TO_FETCH_ERROR,
  FAILED_TO_FETCH_MESSAGE,
  FAILED_TO_RETRIEVE_CONTACT_PUBLIC_KEY_ERROR,
} from './services/auth.js';

export {
  AnnouncementService,
  EstablishSessionError,
} from './services/announcement.js';
export type { AnnouncementReceptionResult } from './services/announcement.js';

export { MessageService } from './services/message.js';
export type { MessageResult, SendMessageResult } from './services/message.js';

export { DiscussionService } from './services/discussion.js';

export { RefreshService } from './services/refresh.js';

// Contact Management
export {
  getContacts,
  getContact,
  addContact,
  updateContactName,
  deleteContact,
} from './contacts.js';
export type {
  UpdateContactNameResult,
  DeleteContactResult,
} from './utils/contacts.js';

// Discussion utilities
export { updateDiscussionName } from './utils/discussions.js';
export type { UpdateDiscussionNameResult } from './utils/discussions.js';

// Types
export * from './types.js';

// Message Protocol
export {
  createMessageProtocol,
  restMessageProtocol,
  RestMessageProtocol,
  MessageProtocol,
} from './api/messageProtocol/index.js';
export type {
  IMessageProtocol,
  EncryptedMessage,
  MessageProtocolResponse,
  BulletinItem,
} from './api/messageProtocol/index.js';

// Config
export {
  setProtocolBaseUrl,
  resetProtocolBaseUrl,
  MessageProtocolType,
  protocolConfig,
} from './config/protocol.js';
export type { ProtocolConfig } from './config/protocol.js';

export { defaultSdkConfig, mergeConfig } from './config/sdk.js';
export type {
  SdkConfig,
  PollingConfig,
  MessagesConfig,
  AnnouncementsConfig,
  DeepPartial,
} from './config/sdk.js';

// Database
export { setDb, getDb, db, GossipDatabase } from './db.js';

// WASM utilities
export { SessionModule, sessionStatusToString } from './wasm/session.js';
export {
  initializeWasm,
  ensureWasmInitialized,
  startWasmInitialization,
} from './wasm/loader.js';
export {
  EncryptionKey,
  Nonce,
  generateEncryptionKey,
  generateEncryptionKeyFromSeed,
  encryptionKeyFromBytes,
  generateNonce,
  nonceFromBytes,
  encryptAead,
  decryptAead,
} from './wasm/encryption.js';
export { generateUserKeys, UserKeys } from './wasm/userKeys.js';

// Utility functions
export {
  encodeUserId,
  decodeUserId,
  isValidUserId,
  formatUserId,
  generate as generateUserId,
} from './utils/userId.js';
export {
  validateUsernameFormat,
  validatePassword,
  validateUserIdFormat,
  validateUsernameAvailability,
  validateUsernameFormatAndAvailability,
} from './utils/validation.js';
export type { ValidationResult } from './utils/validation.js';
export {
  encodeToBase64,
  decodeFromBase64,
  encodeToBase64Url,
  decodeFromBase64Url,
} from './utils/base64.js';
export type { Result } from './utils/type.js';

// Message serialization
export {
  MESSAGE_TYPE_KEEP_ALIVE,
  serializeKeepAliveMessage,
  serializeRegularMessage,
  serializeReplyMessage,
  serializeForwardMessage,
  deserializeMessage,
} from './utils/messageSerialization.js';
export type { DeserializedMessage } from './utils/messageSerialization.js';

// Crypto utilities
export {
  generateMnemonic,
  validateMnemonic,
  mnemonicToSeed,
  accountFromMnemonic,
  PRIVATE_KEY_VERSION,
} from './crypto/bip39.js';
export { encrypt, decrypt, deriveKey } from './crypto/encryption.js';

// WASM types re-exported for convenience
export {
  UserPublicKeys,
  UserSecretKeys,
  SessionStatus,
  SessionConfig,
  SessionManagerWrapper,
  SendMessageOutput,
  ReceiveMessageOutput,
  AnnouncementResult,
  generate_user_keys,
} from './wasm/bindings.js';
