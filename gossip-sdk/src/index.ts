/**
 * Gossip SDK
 *
 * Main entry point for the Gossip SDK.
 * Works in both browser and Node.js environments.
 *
 * WASM is loaded via the #wasm subpath import which resolves conditionally:
 * - Browser: web target (uses import.meta.url)
 * - Node: nodejs target (uses fs, no import.meta.url)
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
export { gossipSdk, GossipSdkImpl } from './gossipSdk';
export type {
  GossipSdkInitOptions,
  OpenSessionOptions,
  SdkEventType,
  SdkEventHandlers,
} from './gossipSdk';

// SDK Events
export type { GossipSdkEvents } from './types/events';

// Services
export { AuthService } from './services/auth';
export type { PublicKeyResult } from './services/auth';
export {
  getPublicKeyErrorMessage,
  PUBLIC_KEY_NOT_FOUND_ERROR,
  PUBLIC_KEY_NOT_FOUND_MESSAGE,
  FAILED_TO_FETCH_ERROR,
  FAILED_TO_FETCH_MESSAGE,
  FAILED_TO_RETRIEVE_CONTACT_PUBLIC_KEY_ERROR,
} from './services/auth';

export {
  AnnouncementService,
  EstablishSessionError,
} from './services/announcement';
export type { AnnouncementReceptionResult } from './services/announcement';

export { MessageService } from './services/message';
export type { MessageResult, SendMessageResult } from './services/message';

export { DiscussionService } from './services/discussion';

export { RefreshService } from './services/refresh';

// Contact Management
export {
  getContacts,
  getContact,
  addContact,
  updateContactName,
  deleteContact,
} from './contacts';
export type {
  UpdateContactNameResult,
  DeleteContactResult,
} from './utils/contacts';

// Discussion utilities
export { updateDiscussionName } from './utils/discussions';
export type { UpdateDiscussionNameResult } from './utils/discussions';

// Types
export * from './types';

// Message Protocol
export {
  createMessageProtocol,
  restMessageProtocol,
  RestMessageProtocol,
  MessageProtocol,
} from './api/messageProtocol';
export type {
  IMessageProtocol,
  EncryptedMessage,
  MessageProtocolResponse,
  BulletinItem,
} from './api/messageProtocol';

// Config
export {
  setProtocolBaseUrl,
  resetProtocolBaseUrl,
  MessageProtocolType,
  protocolConfig,
} from './config/protocol';
export type { ProtocolConfig } from './config/protocol';

export { defaultSdkConfig, mergeConfig } from './config/sdk';
export type {
  SdkConfig,
  PollingConfig,
  MessagesConfig,
  AnnouncementsConfig,
  DeepPartial,
} from './config/sdk';

// Database
export { setDb, getDb, db, GossipDatabase } from './db';

// WASM utilities
export { SessionModule, sessionStatusToString } from './wasm/session';
export {
  initializeWasm,
  ensureWasmInitialized,
  startWasmInitialization,
} from './wasm/loader';
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
} from './wasm/encryption';
export { generateUserKeys, UserKeys } from './wasm/userKeys';

// Utility functions
export {
  encodeUserId,
  decodeUserId,
  isValidUserId,
  formatUserId,
  generate as generateUserId,
} from './utils/userId';
export {
  validateUsernameFormat,
  validatePassword,
  validateUserIdFormat,
  validateUsernameAvailability,
  validateUsernameFormatAndAvailability,
} from './utils/validation';
export type { ValidationResult } from './utils/validation';
export {
  encodeToBase64,
  decodeFromBase64,
  encodeToBase64Url,
  decodeFromBase64Url,
} from './utils/base64';
export type { Result } from './utils/type';

// Message serialization
export {
  MESSAGE_TYPE_KEEP_ALIVE,
  serializeKeepAliveMessage,
  serializeRegularMessage,
  serializeReplyMessage,
  serializeForwardMessage,
  deserializeMessage,
} from './utils/messageSerialization';
export type { DeserializedMessage } from './utils/messageSerialization';

// Crypto utilities
export {
  generateMnemonic,
  validateMnemonic,
  mnemonicToSeed,
  accountFromMnemonic,
  PRIVATE_KEY_VERSION,
} from './crypto/bip39';
export { encrypt, decrypt, deriveKey } from './crypto/encryption';

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
} from './wasm/bindings';
