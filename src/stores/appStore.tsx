import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { NetworkName } from '@massalabs/massa-web3';
import { createSelectors } from './utils/createSelectors';
import { STORAGE_KEYS } from '../utils/localStorage';
import { ParsedInvite } from '../utils/qrCodeParser';

interface AppStoreState {
  // Network config (read by accountStore)
  networkName: NetworkName;
  setNetworkName: (networkName: NetworkName) => void;
  // Debug options visibility
  showDebugOption: boolean;
  setShowDebugOption: (show: boolean) => void;
  // Own UserID visibility
  showUserId: boolean;
  setShowUserId: (show: boolean) => void;
  // Contact UserID visibility
  showContactUserId: boolean;
  setShowContactUserId: (show: boolean) => void;
  // Debug overlay visibility
  debugOverlayVisible: boolean;
  setDebugOverlayVisible: (visible: boolean) => void;
  // App initialization state (whether app has checked for existing accounts)
  isInitialized: boolean;
  setIsInitialized: (value: boolean) => void;
  // Pending deep link
  pendingDeepLinkInfo: ParsedInvite | null;
  setPendingDeepLinkInfo: (value: ParsedInvite | null) => void;
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
      // Own UserID visibility
      showUserId: true,
      setShowUserId: (show: boolean) => {
        set({ showUserId: show });
      },
      // Contact UserID visibility
      showContactUserId: true,
      setShowContactUserId: (show: boolean) => {
        set({ showContactUserId: show });
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
      pendingDeepLinkInfo: null,
      setPendingDeepLinkInfo: (value: ParsedInvite | null) => {
        set({ pendingDeepLinkInfo: value });
      },
    }),
    {
      name: STORAGE_KEYS.APP_STORE,
      storage: createJSONStorage(() => localStorage),
      partialize: state => ({
        showDebugOption: state.showDebugOption,
        showUserId: state.showUserId,
        showContactUserId: state.showContactUserId,
        debugOverlayVisible: state.debugOverlayVisible,
        isInitialized: state.isInitialized,
        networkName: state.networkName,
        setPendingDeepLinkInfo: state.setPendingDeepLinkInfo,
      }),
    }
  )
);

export const useAppStore = createSelectors(useAppStoreBase);
