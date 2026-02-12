import { create } from 'zustand';
import { GossipSdk } from '@massalabs/gossip-sdk';
import { createSelectors } from './utils/createSelectors';
import { setupSdkEventHandlers } from '../services';

interface SdkState {
  sdk: GossipSdk | null;
  setSdk: (sdk: GossipSdk) => void;
}

let eventHandlersSetUp = false;

const useSdkStoreBase = create<SdkState>(set => ({
  sdk: null,
  setSdk: (sdk: GossipSdk) => {
    set({ sdk });
    if (!eventHandlersSetUp) {
      setupSdkEventHandlers(sdk);
      eventHandlersSetUp = true;
    }
  },
}));

export const useSdkStore = createSelectors(useSdkStoreBase);

/** Access SDK from non-React code (stores, services). */
export function getSdk(): GossipSdk {
  const sdk = useSdkStore.getState().sdk;
  if (!sdk) throw new Error('SDK not initialized');
  return sdk;
}
