import { create } from 'zustand';
import {
  MRC20,
  Provider,
  PublicApiUrl,
  NetworkName,
  formatUnits,
  JsonRpcProvider,
} from '@massalabs/massa-web3';
import { useAccountStore } from './accountStore';
import { priceFetcher } from '../utils/fetchPrice';
import { createSelectors } from './utils/createSelectors';

import { FeeConfig } from '../components/wallet/FeeConfigModal';
import { addDebugLog } from '../components/ui/debugLogs';
import { initialTokens } from './utils/const';
import { useAppStore } from './appStore';

type WithNonNull<T, K extends keyof T> = Omit<T, K> & {
  [P in K]-?: NonNullable<T[P]>;
};

export type Ticker = string;

type TokenWithBalance = WithNonNull<TokenState, 'balance'>;

export interface TokenMeta {
  address: string;
  name: string;
  ticker: Ticker;
  icon: string;
  decimals: number;
  isNative: boolean;
}

export interface TokenState extends TokenMeta {
  balance: bigint | null;
  priceUsd: number | null;
  valueUsd: number | null;
}

interface WalletStoreState {
  tokens: TokenState[];
  isLoading: boolean;
  isInitialized: boolean;
  error: string | null;
  feeConfig: FeeConfig;

  initializeTokens: () => Promise<void>;
  getTokenBalances: (provider: Provider) => Promise<TokenWithBalance[]>;
  refreshBalances: () => Promise<void>;
  refreshBalance: (tokenIndex: number) => Promise<void>;

  // Fee configuration
  setFeeConfig: (config: FeeConfig) => void;
  getFeeConfig: () => FeeConfig;
}

const useWalletStoreBase = create<WalletStoreState>((set, get) => ({
  tokens: initialTokens,
  isLoading: false,
  isInitialized: false,
  error: null,
  feeConfig: {
    type: 'preset',
    preset: 'standard',
  },

  initializeTokens: async () => {
    // TODO - Load user's custom token list from IndexedDB (or other persistent storage) and initialize tokens array
  },

  getTokenBalances: async (provider: Provider): Promise<TokenWithBalance[]> => {
    const tokens = get().tokens;

    return Promise.all(
      tokens.map(async token => {
        let balance = 0n;
        try {
          if (token.isNative) {
            balance = await provider.balance(false);
          } else {
            const tokenWrapper = new MRC20(provider, token.address);
            balance = await tokenWrapper.balanceOf(provider.address);
          }
        } catch (error) {
          // TODO: Display error for User ?
          addDebugLog(
            `Error getting balance for ${token.name}: ${error instanceof Error ? error.message : 'Unknown error'}`
          );
        }
        return { ...token, balance };
      })
    );
  },

  refreshBalances: async () => {
    const provider = useAccountStore.getState().provider;
    if (!provider) {
      set({ error: 'No provider available' });
      return;
    }
    set({ isLoading: true, error: null });

    try {
      const tokenWithBalances = await get().getTokenBalances(provider);

      const tokenTickers = tokenWithBalances.map(token => token.ticker);

      const prices = await priceFetcher.getUsdPrices(tokenTickers);

      const updatedTokens = tokenWithBalances.map(token => {
        const priceUsd = prices[token.ticker.toUpperCase()];
        const balance = Number(formatUnits(token.balance, token.decimals));
        const valueUsd = priceUsd != null ? balance * priceUsd : null;

        return {
          ...token,
          priceUsd,
          valueUsd,
        };
      });

      set({
        tokens: updatedTokens,
        isLoading: false,
        error: null,
      });
    } catch (error) {
      console.error('Error refreshing wallet:', error);
      set({ isLoading: false, error: 'Failed to refresh wallet' });
    }
  },

  refreshBalance: async (tokenIndex: number) => {
    try {
      const provider = useAccountStore.getState().provider;
      if (!provider) {
        set({ error: 'No provider available' });
        return;
      }

      const tokens = get().tokens;
      const token = tokens[tokenIndex];
      if (!token) return;

      let balance = 0n;
      try {
        if (token.isNative) {
          balance = await provider.balance(false);
        } else {
          const tokenWrapper = new MRC20(provider, token.address);
          balance = await tokenWrapper.balanceOf(provider.address);
        }
      } catch (e) {
        addDebugLog(`Error getting balance for ${token.name}: ${e}`);
      }

      // Fetch only this token price
      const prices = await priceFetcher.getUsdPrices([token.ticker]);
      const priceUsd = prices[token.ticker.toUpperCase()];
      const balanceWhole = Number(formatUnits(balance, token.decimals));
      const valueUsd = priceUsd != null ? balanceWhole * priceUsd : null;

      const updated: TokenState = { ...token, balance, priceUsd, valueUsd };
      const next = tokens.slice();
      next[tokenIndex] = updated;
      set({ tokens: next });
    } catch (error) {
      console.error('Error refreshing token balance:', error);
    }
  },

  // Fee configuration methods
  setFeeConfig: (config: FeeConfig) => {
    set({ feeConfig: config });
  },

  getFeeConfig: (): FeeConfig => {
    return get().feeConfig;
  },
}));

useAccountStore.subscribe(async (state, prevState) => {
  if (state.account === prevState.account) return;

  try {
    const networkName = useAppStore.getState().networkName;
    const publicApiUrl =
      networkName === NetworkName.Buildnet
        ? PublicApiUrl.Buildnet
        : PublicApiUrl.Mainnet;

    if (state.account) {
      const provider = await JsonRpcProvider.fromRPCUrl(
        publicApiUrl,
        state.account
      );

      useAccountStore.setState({ provider });

      await useWalletStore.getState().initializeTokens();
      await useWalletStore.getState().refreshBalances();
    } else {
      useAccountStore.setState({ provider: null });
    }
  } catch (error) {
    console.error('Error initializing provider:', error);
  }
});

export const useWalletStore = createSelectors(useWalletStoreBase);
