/**
 * Wallet Operations SDK
 *
 * Functions for managing wallet and token balances
 */

import { useWalletStore } from '../../src/stores/walletStore';
import type { Provider } from '@massalabs/massa-web3';
import type { TokenState, FeeConfig } from '../../src/stores/walletStore';

/**
 * Refresh all token balances
 * @returns Result with success status
 */
export async function refreshBalances(): Promise<{
  success: boolean;
  error?: string;
}> {
  try {
    const store = useWalletStore.getState();
    await store.refreshBalances();
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Refresh balance for a specific token
 * @param tokenIndex - Index of the token in the tokens array
 * @returns Result with success status
 */
export async function refreshBalance(tokenIndex: number): Promise<{
  success: boolean;
  error?: string;
}> {
  try {
    const store = useWalletStore.getState();
    await store.refreshBalance(tokenIndex);
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Get token balances for a provider
 * @param provider - Massa Web3 Provider instance
 * @returns Array of tokens with balances
 */
export async function getTokenBalances(
  provider: Provider
): Promise<TokenState[]> {
  try {
    const store = useWalletStore.getState();
    const tokensWithBalances = await store.getTokenBalances(provider);
    return tokensWithBalances;
  } catch (error) {
    console.error('Error getting token balances:', error);
    return [];
  }
}

/**
 * Get list of tokens
 * @returns Array of token states
 */
export function getTokens(): TokenState[] {
  const store = useWalletStore.getState();
  return store.tokens;
}

/**
 * Set fee configuration
 * @param config - Fee configuration object
 */
export function setFeeConfig(config: FeeConfig): void {
  const store = useWalletStore.getState();
  store.setFeeConfig(config);
}

/**
 * Get fee configuration
 * @returns Current fee configuration
 */
export function getFeeConfig(): FeeConfig {
  const store = useWalletStore.getState();
  return store.getFeeConfig();
}
