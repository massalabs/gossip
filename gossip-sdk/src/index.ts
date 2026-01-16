/**
 * Gossip SDK
 *
 * Main entry point for the Gossip SDK.
 * Provides a platform-agnostic interface for automation, chatbot,
 * and integration use cases with the Gossip messenger. Configure
 * runtime adapters (stores, db, preferences, notifications) before use.
 *
 * @example
 * ```typescript
 * import {
 *   configureSdk,
 *   initializeAccount,
 *   addContact,
 *   initializeDiscussion,
 *   sendMessage,
 *   getSession,
 * } from 'gossip-sdk';
 *
 * configureSdk({
 *   accountStore,
 *   walletStore,
 *   db,
 *   preferences,
 *   notificationHandler,
 * });
 *
 * // Create a new account
 * const accountResult = await initializeAccount('alice', 'secure-password');
 * if (!accountResult.success) {
 *   throw new Error(accountResult.error);
 * }
 *
 * // Get session for operations
 * const session = getSession();
 *
 * // Add a contact and start a discussion
 * const contactResult = await addContact(
 *   accountResult.userProfile.userId,
 *   contactUserId,
 *   'Bob',
 *   bobPublicKeys
 * );
 *
 * if (contactResult.success && session) {
 *   const discussionResult = await initializeDiscussion(
 *     contactResult.contact,
 *     session,
 *     'Hello Bob!'
 *   );
 * }
 * ```
 *
 * @packageDocumentation
 */

// SDK version - matches package.json
export const SDK_VERSION = '0.0.1';

// Account Management
export {
  initializeAccount,
  loadAccount,
  restoreAccountFromMnemonic,
  logout,
  resetAccount,
  showBackup,
  getAllAccounts,
  hasExistingAccount,
  getCurrentAccount,
  getMnemonicBackupInfo,
  markMnemonicBackupComplete,
} from './account';
export type {
  InitializeAccountResult,
  LoadAccountResult,
  RestoreAccountResult,
  BackupResult,
} from './account';
export type { AccountStoreAdapter, AccountStoreState } from './utils';

// Authentication & Public Keys
export { fetchPublicKeyByUserId, ensurePublicKeyPublished } from './auth';

// Contact Management
export {
  getContacts,
  getContact,
  addContact,
  updateContactName,
  deleteContact,
} from './contacts';

// Discussion Management
export {
  initializeDiscussion,
  acceptDiscussionRequest,
  renewDiscussion,
  updateDiscussionName,
  isDiscussionStableState,
  getDiscussions,
  getDiscussion,
  getActiveDiscussions,
  getUnreadCount,
  markDiscussionAsRead,
} from './discussions';

// Message Operations
export {
  sendMessage,
  fetchMessages,
  resendMessages,
  findMessageBySeeker,
  getMessages,
  getMessage,
  getMessagesForContact,
} from './messages';

// Announcement Handling
export {
  fetchAndProcessAnnouncements,
  resendAnnouncements,
  sendAnnouncement,
  establishSession,
} from './announcements';

// Wallet Operations
export {
  initializeTokens,
  refreshBalances,
  refreshBalance,
  getTokenBalances,
  getTokens,
  isWalletLoading,
  isWalletInitialized,
  getWalletError,
  getFeeConfig,
  setFeeConfig,
} from './wallet';
export type {
  TokenState,
  TokenMeta,
  Ticker,
  FeeConfig,
  WalletStoreAdapter,
  WalletStoreState,
} from './wallet';

// Types - re-export all types from the types module
export * from './types';

// Utilities
export {
  getSession,
  getAccount,
  getSessionKeys,
  ensureInitialized,
  getCurrentUserId,
  isAccountLoaded,
  isAccountLoading,
  configureSdk,
  setAccountStore,
  getAccountStore,
} from './utils';

// Services - for direct use by host apps and other clients
export { authService, AuthService } from './services/auth';
export type { PublicKeyResult } from './services/auth';
// Note: initializeDiscussion, acceptDiscussionRequest, renewDiscussion, isDiscussionStableState
// are already exported from ./discussions which re-exports from ./services/discussion
export { messageService, MessageService } from './services/message';
export {
  announcementService,
  AnnouncementService,
} from './services/announcement';
export type { NotificationHandler } from './services/announcement';

// Message Protocol - for direct use by host apps
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

// Config - for runtime configuration
export {
  setProtocolBaseUrl,
  resetProtocolBaseUrl,
  MessageProtocolType,
  protocolConfig,
} from './config/protocol';
export type { ProtocolConfig } from './config/protocol';

// Database - for direct access by host apps
export { setDb, db, type GossipDatabase } from './db';

// WASM utilities - for session management
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
export { generateUserKeys } from './wasm/userKeys';

// Utility functions - for direct use
export { encodeUserId, decodeUserId } from './utils/userId';
export { validateUsernameFormat, validatePassword } from './utils/validation';
export {
  getLastSyncTimestamp,
  setLastSyncTimestamp,
  setApiBaseUrlForBackgroundSync,
  setActiveSeekersInPreferences,
  setPreferencesAdapter,
  setForegroundChecker,
} from './utils/preferences';
