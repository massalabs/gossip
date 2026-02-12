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
 * import { createGossipSdk } from '@massalabs/gossip-sdk';
 *
 * const sdk = createGossipSdk();
 * await sdk.init({ protocolBaseUrl: 'https://api.example.com' });
 * await sdk.openSession({ mnemonic: '...' });
 * await sdk.messages.send(contactId, 'Hello!');
 * ```
 *
 * @packageDocumentation
 */

// ─────────────────────────────────────────────────────────────────────────────
// SDK Factory & Class - Primary API
// ─────────────────────────────────────────────────────────────────────────────
export { createGossipSdk, GossipSdk } from './gossipSdk';
export type {
  GossipSdkInitOptions,
  OpenSessionOptions,
  SdkEventHandlers,
} from './gossipSdk';
export { SdkEventType } from './gossipSdk';

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

// Announcement payload helpers
export {
  encodeAnnouncementPayload,
  decodeAnnouncementPayload,
} from './utils/announcementPayload';
export type { AnnouncementPayload } from './utils/announcementPayload';

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
export { gossipDb, GossipDatabase } from './db';

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
