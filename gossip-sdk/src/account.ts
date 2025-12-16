/**
 * Account Management SDK
 *
 * Functions for managing user accounts (password-based authentication only)
 */

import { useAccountStore } from '../../src/stores/accountStore';
import type { UserProfile } from '../../src/db';
import type { Account } from '@massalabs/massa-web3';

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
 * Create a new account with username and password
 * @param username - Username for the account
 * @param password - Password for the account
 * @returns Result with success status and optional userProfile
 */
export async function initializeAccount(
  username: string,
  password: string
): Promise<InitializeAccountResult> {
  try {
    const store = useAccountStore.getState();
    await store.initializeAccount(username, password);
    const state = useAccountStore.getState();
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
 * Load an existing account
 * @param password - Password for the account (optional if only one account exists)
 * @param userId - Optional specific user ID to load
 * @returns Result with success status and optional userProfile
 */
export async function loadAccount(
  password?: string,
  userId?: string
): Promise<LoadAccountResult> {
  try {
    const store = useAccountStore.getState();
    await store.loadAccount(password, userId);
    const state = useAccountStore.getState();
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
 * Restore an account from mnemonic phrase
 * @param username - Username for the account
 * @param mnemonic - BIP39 mnemonic phrase
 * @param password - Password for the account
 * @returns Result with success status and optional userProfile
 */
export async function restoreAccountFromMnemonic(
  username: string,
  mnemonic: string,
  password: string
): Promise<RestoreAccountResult> {
  try {
    const store = useAccountStore.getState();
    await store.restoreAccountFromMnemonic(username, mnemonic, {
      useBiometrics: false,
      password,
    });
    const state = useAccountStore.getState();
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
 * Logout current account (clears in-memory state but keeps data in database)
 * @returns Result with success status
 */
export async function logout(): Promise<{ success: boolean; error?: string }> {
  try {
    const store = useAccountStore.getState();
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
 * Reset/delete current account (deletes account from database)
 * @returns Result with success status
 */
export async function resetAccount(): Promise<{
  success: boolean;
  error?: string;
}> {
  try {
    const store = useAccountStore.getState();
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
 * Get mnemonic backup for current account
 * @param password - Password for the account
 * @returns Result with mnemonic and account info
 */
export async function showBackup(password?: string): Promise<BackupResult> {
  try {
    const store = useAccountStore.getState();
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
 * Get all accounts
 * @returns Array of user profiles
 */
export async function getAllAccounts(): Promise<UserProfile[]> {
  try {
    const store = useAccountStore.getState();
    return await store.getAllAccounts();
  } catch (error) {
    console.error('Error getting all accounts:', error);
    return [];
  }
}

/**
 * Check if any account exists
 * @returns True if at least one account exists
 */
export async function hasExistingAccount(): Promise<boolean> {
  try {
    const store = useAccountStore.getState();
    return await store.hasExistingAccount();
  } catch (error) {
    console.error('Error checking for existing account:', error);
    return false;
  }
}

/**
 * Get current account info
 * @returns Current user profile or null
 */
export function getCurrentAccount(): UserProfile | null {
  const state = useAccountStore.getState();
  return state.userProfile ?? null;
}

/**
 * Get mnemonic backup info (creation date and backup status)
 * @returns Backup info or null if no backup exists
 */
export function getMnemonicBackupInfo(): {
  createdAt: Date;
  backedUp: boolean;
} | null {
  const store = useAccountStore.getState();
  return store.getMnemonicBackupInfo();
}

/**
 * Mark mnemonic backup as complete
 * @returns Result with success status
 */
export async function markMnemonicBackupComplete(): Promise<{
  success: boolean;
  error?: string;
}> {
  try {
    const store = useAccountStore.getState();
    await store.markMnemonicBackupComplete();
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
