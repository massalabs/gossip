/**
 * Gossip SDK
 *
 * Main entry point for the Gossip SDK.
 * Provides a platform-agnostic interface for automation, chatbot,
 * and integration use cases with the Gossip messenger.
 *
 * @example
 * ```typescript
 * import {
 *   initializeAccount,
 *   addContact,
 *   initializeDiscussion,
 *   sendMessage,
 *   getSession,
 * } from 'gossip-sdk';
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
 * if (contactResult.success) {
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
} from './utils';
