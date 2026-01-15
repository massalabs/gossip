/**
 * Account Management SDK
 *
 * Functions for managing user accounts including creation, loading,
 * restoration from mnemonic, and backup operations.
 *
 * @example
 * ```typescript
 * import { initializeAccount, getCurrentAccount, logout } from 'gossip-sdk';
 *
 * // Create a new account
 * const result = await initializeAccount('alice', 'secure-password');
 * if (result.success) {
 *   console.log('Account created:', result.userProfile?.username);
 * }
 *
 * // Get current account
 * const account = getCurrentAccount();
 *
 * // Logout
 * await logout();
 * ```
 */

import type { Account } from '@massalabs/massa-web3';
import type { UserProfile } from './db';
import { getAccountStore } from './utils';

export interface InitializeAccountResult {
  success: boolean;
  error?: string;
  userProfile?: UserProfile;
}

export interface LoadAccountResult {
  success: boolean;
  error?: string;
  userProfile?: UserProfile;
}

export interface RestoreAccountResult {
  success: boolean;
  error?: string;
  userProfile?: UserProfile;
}

export interface BackupResult {
  success: boolean;
  error?: string;
  mnemonic?: string;
  account?: Account;
}

/**
 * Create a new account with username and password.
 * Generates a new mnemonic and derives keys from it.
 *
 * @param username - Username for the account
 * @param password - Password for encrypting the account
 * @returns Result with success status and optional userProfile
 *
 * @example
 * ```typescript
 * const result = await initializeAccount('alice', 'my-secure-password');
 * if (result.success) {
 *   console.log('Account created:', result.userProfile?.userId);
 * } else {
 *   console.error('Failed:', result.error);
 * }
 * ```
 */
export async function initializeAccount(
  username: string,
  password: string
): Promise<InitializeAccountResult> {
  try {
    const store = getAccountStore();
    await store.initializeAccount(username, password);
    const state = store.getState();
    return {
      success: true,
      userProfile: state.userProfile ?? undefined,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Load an existing account from the database.
 *
 * @param password - Password to decrypt the account (optional for biometric auth)
 * @param userId - Optional specific user ID to load (loads first account if not specified)
 * @returns Result with success status and optional userProfile
 *
 * @example
 * ```typescript
 * const result = await loadAccount('my-password');
 * if (result.success) {
 *   console.log('Loaded account:', result.userProfile?.username);
 * }
 * ```
 */
export async function loadAccount(
  password?: string,
  userId?: string
): Promise<LoadAccountResult> {
  try {
    const store = getAccountStore();
    await store.loadAccount(password, userId);
    const state = store.getState();
    return {
      success: true,
      userProfile: state.userProfile ?? undefined,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Restore an account from a BIP39 mnemonic phrase.
 *
 * @param username - Username for the account
 * @param mnemonic - BIP39 mnemonic phrase (12 or 24 words)
 * @param password - Password for encrypting the account
 * @returns Result with success status and optional userProfile
 *
 * @example
 * ```typescript
 * const mnemonic = 'word1 word2 word3 ... word12';
 * const result = await restoreAccountFromMnemonic('alice', mnemonic, 'password');
 * if (result.success) {
 *   console.log('Account restored:', result.userProfile?.userId);
 * }
 * ```
 */
export async function restoreAccountFromMnemonic(
  username: string,
  mnemonic: string,
  password: string
): Promise<RestoreAccountResult> {
  try {
    const store = getAccountStore();
    await store.restoreAccountFromMnemonic(username, mnemonic, {
      useBiometrics: false,
      password,
    });
    const state = getAccountStore().getState();
    return {
      success: true,
      userProfile: state.userProfile ?? undefined,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Logout current account.
 * Clears in-memory state but keeps data in the database.
 *
 * @returns Result with success status
 *
 * @example
 * ```typescript
 * const result = await logout();
 * if (result.success) {
 *   console.log('Logged out successfully');
 * }
 * ```
 */
export async function logout(): Promise<{ success: boolean; error?: string }> {
  try {
    const store = getAccountStore();
    await store.logout();
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Reset/delete current account.
 * Permanently deletes the account from the database.
 *
 * @returns Result with success status
 *
 * @example
 * ```typescript
 * const result = await resetAccount();
 * if (result.success) {
 *   console.log('Account deleted');
 * }
 * ```
 */
export async function resetAccount(): Promise<{
  success: boolean;
  error?: string;
}> {
  try {
    const store = getAccountStore();
    await store.resetAccount();
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Get mnemonic backup for current account.
 * Requires password authentication.
 *
 * @param password - Password for the account
 * @returns Result with mnemonic and account info
 *
 * @example
 * ```typescript
 * const backup = await showBackup('my-password');
 * if (backup.success) {
 *   console.log('Mnemonic:', backup.mnemonic);
 *   console.log('Address:', backup.account?.address.toString());
 * }
 * ```
 */
export async function showBackup(password?: string): Promise<BackupResult> {
  try {
    const store = getAccountStore();
    const backup = await store.showBackup(password);
    return {
      success: true,
      mnemonic: backup.mnemonic,
      account: backup.account,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Get all accounts stored in the database.
 *
 * @returns Array of user profiles
 *
 * @example
 * ```typescript
 * const accounts = await getAllAccounts();
 * accounts.forEach(acc => console.log(acc.username));
 * ```
 */
export async function getAllAccounts(): Promise<UserProfile[]> {
  try {
    const store = getAccountStore();
    return await store.getAllAccounts();
  } catch (error) {
    console.error('Error getting all accounts:', error);
    return [];
  }
}

/**
 * Check if any account exists in the database.
 *
 * @returns True if at least one account exists
 *
 * @example
 * ```typescript
 * const hasAccount = await hasExistingAccount();
 * if (hasAccount) {
 *   // Show login screen
 * } else {
 *   // Show registration screen
 * }
 * ```
 */
export async function hasExistingAccount(): Promise<boolean> {
  try {
    const store = getAccountStore();
    return await store.hasExistingAccount();
  } catch (error) {
    console.error('Error checking for existing account:', error);
    return false;
  }
}

/**
 * Get current logged-in account info.
 *
 * @returns Current user profile or null if not logged in
 *
 * @example
 * ```typescript
 * const current = getCurrentAccount();
 * if (current) {
 *   console.log('Logged in as:', current.username);
 * }
 * ```
 */
export function getCurrentAccount(): UserProfile | null {
  const state = getAccountStore().getState();
  return state.userProfile ?? null;
}

/**
 * Get mnemonic backup info (creation date and backup status).
 *
 * @returns Backup info or null if no backup exists
 *
 * @example
 * ```typescript
 * const info = getMnemonicBackupInfo();
 * if (info) {
 *   console.log('Created:', info.createdAt);
 *   console.log('Backed up:', info.backedUp);
 * }
 * ```
 */
export function getMnemonicBackupInfo(): {
  createdAt: Date;
  backedUp: boolean;
} | null {
  const store = getAccountStore();
  return store.getMnemonicBackupInfo();
}

/**
 * Mark mnemonic backup as complete.
 * Call this after user has safely stored their mnemonic.
 *
 * @returns Result with success status
 *
 * @example
 * ```typescript
 * const result = await markMnemonicBackupComplete();
 * if (result.success) {
 *   console.log('Backup marked as complete');
 * }
 * ```
 */
export async function markMnemonicBackupComplete(): Promise<{
  success: boolean;
  error?: string;
}> {
  try {
    const store = getAccountStore();
    await store.markMnemonicBackupComplete();
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
