/**
 * SDK Utilities
 *
 * Helper functions for accessing stores, session, and common operations.
 *
 * @example
 * ```typescript
 * import { getSession, getCurrentUserId, ensureInitialized } from 'gossip-sdk';
 *
 * // Get current session
 * const session = getSession();
 *
 * // Get current user ID
 * const userId = getCurrentUserId();
 *
 * // Ensure account is loaded before operations
 * ensureInitialized();
 * ```
 */

import type { Account } from '@massalabs/massa-web3';
import type { EncryptionKey } from './wasm';
import type { SessionModule as AppSessionModule } from '@/wasm/session';
import type {
  UserPublicKeys,
  UserSecretKeys,
} from '@/assets/generated/wasm/gossip_wasm';
import type { UserProfile, GossipDatabase } from './db';
import type { PreferencesAdapter } from './utils/preferences';
import type { NotificationHandler } from './services/announcement';
import { setPreferencesAdapter } from './utils/preferences';
import { setDb } from './db';
import { announcementService } from './services/announcement';
import { messageService } from './services/message';
import { restMessageProtocol } from './api/messageProtocol';
import { setAuthMessageProtocol } from './services/auth';
import { setWalletStore, type WalletStoreAdapter } from './wallet';

export interface AccountStoreState {
  userProfile: UserProfile | null;
  encryptionKey: EncryptionKey | null;
  session: AppSessionModule | null;
  isLoading: boolean;
  account: Account | null;
}

export interface AccountStoreAdapter {
  getState(): AccountStoreState;
  initializeAccount(username: string, password: string): Promise<void>;
  initializeAccountWithBiometrics(
    username: string,
    iCloudSync?: boolean
  ): Promise<void>;
  loadAccount(password?: string, userId?: string): Promise<void>;
  restoreAccountFromMnemonic(
    username: string,
    mnemonic: string,
    opts: { useBiometrics: boolean; password?: string }
  ): Promise<void>;
  logout(): Promise<void>;
  resetAccount(): Promise<void>;
  showBackup(
    password?: string
  ): Promise<{ mnemonic: string; account: Account }>;
  getMnemonicBackupInfo(): { createdAt: Date; backedUp: boolean } | null;
  markMnemonicBackupComplete(): Promise<void>;
  getAllAccounts(): Promise<UserProfile[]>;
  hasExistingAccount(): Promise<boolean>;
}

let accountStore: AccountStoreAdapter | null = null;

export function setAccountStore(store: AccountStoreAdapter): void {
  accountStore = store;
}

export function getAccountStore(): AccountStoreAdapter {
  if (!accountStore) {
    throw new Error('Account store adapter not configured.');
  }
  return accountStore;
}

/**
 * Get current session module from account store.
 * The session is required for most cryptographic operations.
 *
 * @returns SessionModule or null if not loaded
 *
 * @example
 * ```typescript
 * const session = getSession();
 * if (session) {
 *   // Can perform operations that require session
 * }
 * ```
 */
export function getSession(): AppSessionModule | null {
  const state = getAccountStore().getState();
  return state.session as AppSessionModule | null;
}

/**
 * Get current account state with all relevant fields.
 * Provides access to user profile, encryption key, and session.
 *
 * @returns Account state object
 *
 * @example
 * ```typescript
 * const account = getAccount();
 * if (account.session && account.userProfile) {
 *   console.log('Logged in as:', account.userProfile.username);
 * }
 * ```
 */
export function getAccount(): {
  userProfile: UserProfile | null;
  encryptionKey: EncryptionKey | null;
  session: AppSessionModule | null;
} {
  const state = getAccountStore().getState();
  return {
    userProfile: state.userProfile,
    encryptionKey: state.encryptionKey,
    session: state.session as AppSessionModule | null,
  };
}

/**
 * Get public and secret keys from current session.
 * Returns null values if session is not loaded.
 *
 * @returns Object with public and secret keys
 *
 * @example
 * ```typescript
 * const keys = getSessionKeys();
 * if (keys.ourPk && keys.ourSk) {
 *   // Use keys for cryptographic operations
 * }
 * ```
 */
export function getSessionKeys(): {
  ourPk: UserPublicKeys | null;
  ourSk: UserSecretKeys | null;
} {
  const state = getAccountStore().getState();
  const session = state.session;
  if (!session) {
    return { ourPk: null, ourSk: null };
  }
  return {
    ourPk: session.ourPk,
    ourSk: session.ourSk,
  };
}

/**
 * Ensure account is loaded and initialized.
 * Throws an error if account is not ready for operations.
 *
 * @throws Error if account is not loaded
 *
 * @example
 * ```typescript
 * try {
 *   ensureInitialized();
 *   // Safe to perform account operations
 * } catch (error) {
 *   console.error('Please login first');
 * }
 * ```
 */
export function ensureInitialized(): void {
  const state = getAccountStore().getState();
  if (!state.userProfile || !state.session) {
    throw new Error('Account not initialized. Please load an account first.');
  }
}

/**
 * Get current user ID.
 *
 * @returns User ID (Bech32-encoded) or null if not loaded
 *
 * @example
 * ```typescript
 * const userId = getCurrentUserId();
 * if (userId) {
 *   console.log('Current user:', userId);
 * }
 * ```
 */
export function getCurrentUserId(): string | null {
  const state = getAccountStore().getState();
  return state.userProfile?.userId ?? null;
}

/**
 * Check if an account is currently loaded.
 *
 * @returns True if account is loaded and session is available
 *
 * @example
 * ```typescript
 * if (isAccountLoaded()) {
 *   // User is logged in
 * } else {
 *   // Show login screen
 * }
 * ```
 */
export function isAccountLoaded(): boolean {
  const state = getAccountStore().getState();
  return !!(state.userProfile && state.session);
}

/**
 * Check if account store is in loading state.
 *
 * @returns True if account operations are in progress
 */
export function isAccountLoading(): boolean {
  const state = getAccountStore().getState();
  return state.isLoading;
}

export interface SdkRuntimeConfig {
  db?: GossipDatabase;
  preferences?: PreferencesAdapter | null;
  notificationHandler?: NotificationHandler;
  accountStore?: AccountStoreAdapter;
  walletStore?: WalletStoreAdapter;
}

export function configureSdk(config: SdkRuntimeConfig): void {
  if (config.db) {
    setDb(config.db);
  }

  if (Object.prototype.hasOwnProperty.call(config, 'preferences')) {
    setPreferencesAdapter(config.preferences ?? null);
  }

  if (config.notificationHandler) {
    announcementService.setNotificationHandler(config.notificationHandler);
  }

  if (config.accountStore) {
    setAccountStore(config.accountStore);
  }

  if (config.walletStore) {
    setWalletStore(config.walletStore);
  }

  messageService.setMessageProtocol(restMessageProtocol);
  setAuthMessageProtocol(restMessageProtocol);
}
