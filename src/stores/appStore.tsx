import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { NetworkName } from '@massalabs/massa-web3';
import { createSelectors } from './utils/createSelectors';
import { STORAGE_KEYS } from '../utils/localStorage';

interface AppStoreState {
  // Network config (read by accountStore)
  networkName: NetworkName;
  setNetworkName: (networkName: NetworkName) => void;
  // Debug options visibility
  showDebugOption: boolean;
  setShowDebugOption: (show: boolean) => void;
  // Debug overlay visibility
  debugOverlayVisible: boolean;
  setDebugOverlayVisible: (visible: boolean) => void;
  // App initialization state (whether app has checked for existing accounts)
  isInitialized: boolean;
  setIsInitialized: (value: boolean) => void;
  // Pending deep link
  pendingDeepLink: string | null;
  setPendingDeepLink: (value: string | null) => void;
}

const useAppStoreBase = create<AppStoreState>()(
  persist(
    set => ({
      // Network config
      networkName: NetworkName.Buildnet,
      setNetworkName: (networkName: NetworkName) => {
        set({ networkName });
      },
      // Debug options visibility
      showDebugOption: false,
      setShowDebugOption: (show: boolean) => {
        set({ showDebugOption: show });
      },
      // Debug overlay visibility
      debugOverlayVisible: false,
      setDebugOverlayVisible: (visible: boolean) => {
        set({ debugOverlayVisible: visible });
      },
      // App initialization state
      isInitialized: false,
      setIsInitialized: (value: boolean) => {
        set({ isInitialized: value });
      },
      // Pending deep link
      pendingDeepLink: null,
      setPendingDeepLink: (value: string | null) => {
        set({ pendingDeepLink: value });
      },
    }),
    {
      name: STORAGE_KEYS.APP_STORE,
      storage: createJSONStorage(() => localStorage),
      partialize: state => ({
        showDebugOption: state.showDebugOption,
        debugOverlayVisible: state.debugOverlayVisible,
        isInitialized: state.isInitialized,
        networkName: state.networkName,
        pendingDeepLink: state.pendingDeepLink,
      }),
    }
  )
);

export const useAppStore = createSelectors(useAppStoreBase);
