import { create } from 'zustand';
import { GossipSdk } from '@massalabs/gossip-sdk';
import { createSelectors } from './utils/createSelectors';

interface SdkState {
  sdk: GossipSdk | null;
  setSdk: (sdk: GossipSdk) => void;
}

const useSdkStoreBase = create<SdkState>(set => ({
  sdk: null,
  setSdk: (sdk: GossipSdk) => set({ sdk }),
}));

export const useSdkStore = createSelectors(useSdkStoreBase);

/** Access SDK from non-React code (stores, services). */
export function getSdk(): GossipSdk {
  const sdk = useSdkStore.getState().sdk;
  if (!sdk)
    throw new Error('SDK not initialized — SdkProvider must mount first');
  return sdk;
}
