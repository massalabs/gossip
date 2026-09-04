import { logger } from '../utils/logger.ts';
import {
  JsonRpcProvider,
  PublicApiUrl,
  NetworkName,
} from '@massalabs/massa-web3';
import { useAppStore } from './appStore';
import { getSdk } from './sdkStore';
import { fetchMnsDomainsIfEnabled } from './utils/accountHelpers';
import type { AccountStoreApi } from './accountStore';

export function registerAccountStoreSubscriptions(store: AccountStoreApi) {
  store.subscribe(async (state, prevState) => {
    const current = state.userProfile;
    const previous = prevState.userProfile;

    const sdk = getSdk();
    if (!current || !sdk.isSessionOpen) return;
    if (current === previous) return;
    if (previous && current.userId === previous.userId) return;

    try {
      await sdk.auth.publishPublicKey(sdk.publicKeys, sdk.userId, sdk.queries);
    } catch (error) {
      logger.error('Error publishing public key:', error);
    }
  });

  // Subscribe to account changes to initialize provider
  store.subscribe(async (state, prevState) => {
    const currentAddress = state.account?.address?.toString();
    const prevAddress = prevState.account?.address?.toString();

    if (currentAddress === prevAddress) return;

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

        // The account may have changed (logout / account switch) while the
        // provider was being created — don't attach a provider bound to a
        // stale account.
        if (store.getState().account !== state.account) return;
        store.setState({ provider });
      } else {
        store.setState({ provider: null });
      }
    } catch (error) {
      logger.error('Error initializing provider:', error);
    }
  });

  // Subscribe to provider changes to fetch MNS domains when provider becomes available
  store.subscribe(async (state, prevState) => {
    if (state.provider === prevState.provider) return;

    if (state.provider && state.userProfile) {
      fetchMnsDomainsIfEnabled(state.userProfile, state.provider);
    }
  });
}
