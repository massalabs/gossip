/**
 * Gossip SDK
 *
 * @example
 * ```typescript
 * import { createGossipSdk } from '@massalabs/gossip-sdk';
 *
 * const sdk = createGossipSdk();
 * await sdk.init();
 * await sdk.openSession({ mnemonic: '...' });
 * ```
 *
 * @packageDocumentation
 */

// ─────────────────────────────────────────────────────────────────────────────
// SDK — Primary API
// ─────────────────────────────────────────────────────────────────────────────

export { createGossipSdk, GossipSdk, SdkEventType } from './gossipSdk';
export type {
  GossipSdkInitOptions,
  OpenSessionOptions,
  SdkEventHandlers,
} from './gossipSdk';

// ─────────────────────────────────────────────────────────────────────────────
// Database — entity types, enums, database class
// ─────────────────────────────────────────────────────────────────────────────

export * from './db';

// ─────────────────────────────────────────────────────────────────────────────
// Utilities — export entire modules (safe: pure functions / types)
// ─────────────────────────────────────────────────────────────────────────────

export * from './utils/userId';
export * from './utils/base64';
export * from './utils/validation';
export * from './utils/announcementPayload';
export * from './utils/discussions';
export * from './utils/contacts';
export type { Result } from './utils/type';

// ─────────────────────────────────────────────────────────────────────────────
// Crypto — key generation, encryption, mnemonic
// ─────────────────────────────────────────────────────────────────────────────

export * from './crypto/bip39';
export * from './crypto/encryption';
export * from './wasm/encryption';
export * from './wasm/userKeys';

// ─────────────────────────────────────────────────────────────────────────────
// WASM bindings — session status, public keys, protocol outputs
// ─────────────────────────────────────────────────────────────────────────────

export {
  SessionStatus,
  UserPublicKeys,
  UserSecretKeys,
  SendMessageOutput,
  ReceiveMessageOutput,
  AnnouncementResult,
} from './wasm/bindings';

// ─────────────────────────────────────────────────────────────────────────────
// Protocol
// ─────────────────────────────────────────────────────────────────────────────

export {
  restMessageProtocol,
  RestMessageProtocol,
} from './api/messageProtocol';
export type { EncryptedMessage } from './api/messageProtocol';
export type { PublicKeyResult } from './services/auth';
