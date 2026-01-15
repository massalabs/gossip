/**
 * Wallet Operations SDK
 *
 * Functions for interacting with the Massa blockchain wallet,
 * including balance checking and token management.
 *
 * @example
 * ```typescript
 * import { refreshBalances, getTokens, getFeeConfig } from 'gossip-sdk';
 *
 * // Refresh all token balances
 * await refreshBalances();
 *
 * // Get token list with balances
 * const tokens = getTokens();
 * ```
 */

import { useWalletStore } from '@/stores/walletStore';
import type { TokenState, TokenMeta, Ticker } from '@/stores/walletStore';
import type { FeeConfig } from '@/components/wallet/FeeConfigModal';
import type { Provider } from '@massalabs/massa-web3';

// Re-export types for consumers
export type { TokenState, TokenMeta, Ticker, FeeConfig };

/**
 * Initialize wallet tokens.
 * Loads user's custom token list from storage.
 *
 * @example
 * ```typescript
 * await initializeTokens();
 * console.log('Tokens initialized');
 * ```
 */
export async function initializeTokens(): Promise<void> {
  const store = useWalletStore.getState();
  return await store.initializeTokens();
}

/**
 * Refresh all token balances and USD prices.
 * Requires a provider to be available (account must be loaded).
 *
 * @example
 * ```typescript
 * await refreshBalances();
 * const tokens = getTokens();
 * tokens.forEach(t => console.log(t.ticker, t.balance, t.valueUsd));
 * ```
 */
export async function refreshBalances(): Promise<void> {
  const store = useWalletStore.getState();
  return await store.refreshBalances();
}

/**
 * Refresh balance for a specific token.
 *
 * @param tokenIndex - Index of the token in the tokens array
 *
 * @example
 * ```typescript
 * // Refresh MAS balance (typically index 0)
 * await refreshBalance(0);
 * ```
 */
export async function refreshBalance(tokenIndex: number): Promise<void> {
  const store = useWalletStore.getState();
  return await store.refreshBalance(tokenIndex);
}

/**
 * Get token balances for a provider.
 * Returns tokens with non-null balances.
 *
 * @param provider - Massa provider instance
 * @returns Array of tokens with balances
 *
 * @example
 * ```typescript
 * const tokens = await getTokenBalances(provider);
 * tokens.forEach(t => console.log(t.ticker, t.balance));
 * ```
 */
export async function getTokenBalances(
  provider: Provider
): Promise<(TokenState & { balance: bigint })[]> {
  const store = useWalletStore.getState();
  return await store.getTokenBalances(provider);
}

/**
 * Get current token list with balances.
 *
 * @returns Array of token states
 *
 * @example
 * ```typescript
 * const tokens = getTokens();
 * const mas = tokens.find(t => t.ticker === 'MAS');
 * if (mas?.balance) {
 *   console.log('MAS balance:', mas.balance);
 * }
 * ```
 */
export function getTokens(): TokenState[] {
  const state = useWalletStore.getState();
  return state.tokens;
}

/**
 * Check if wallet is loading.
 *
 * @returns True if wallet operations are in progress
 */
export function isWalletLoading(): boolean {
  const state = useWalletStore.getState();
  return state.isLoading;
}

/**
 * Check if wallet is initialized.
 *
 * @returns True if wallet has been initialized
 */
export function isWalletInitialized(): boolean {
  const state = useWalletStore.getState();
  return state.isInitialized;
}

/**
 * Get wallet error message if any.
 *
 * @returns Error message or null
 */
export function getWalletError(): string | null {
  const state = useWalletStore.getState();
  return state.error;
}

/**
 * Get current fee configuration.
 *
 * @returns Fee configuration object
 *
 * @example
 * ```typescript
 * const feeConfig = getFeeConfig();
 * console.log('Fee type:', feeConfig.type);
 * ```
 */
export function getFeeConfig(): FeeConfig {
  const store = useWalletStore.getState();
  return store.getFeeConfig();
}

/**
 * Set fee configuration.
 *
 * @param config - New fee configuration
 *
 * @example
 * ```typescript
 * setFeeConfig({ type: 'preset', preset: 'fast' });
 * ```
 */
export function setFeeConfig(config: FeeConfig): void {
  const store = useWalletStore.getState();
  store.setFeeConfig(config);
}
