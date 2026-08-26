import { logger } from '../utils/logger.ts';
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { NetworkName, Provider } from '@massalabs/massa-web3';
import { createSelectors } from './utils/createSelectors';
import { STORAGE_KEYS } from '../utils/localStorage';
import { ParsedInvite } from '../utils/invite';
import { mnsService } from '../services/mns';
import { type AccountSettingsV1, UserProfile } from '@massalabs/gossip-sdk';

// Debug console button position
interface DebugButtonPosition {
  x: number;
  y: number;
}

interface AppStoreState {
  // Terms of Service acceptance
  tosAccepted: boolean;
  setTosAccepted: (value: boolean) => void;
  // Network config (read by accountStore)
  networkName: NetworkName;
  setNetworkName: (networkName: NetworkName) => void;
  // Debug options visibility
  showDebugOption: boolean;
  setShowDebugOption: (show: boolean) => void;
  // Debug overlay visibility
  debugOverlayVisible: boolean;
  setDebugOverlayVisible: (visible: boolean) => void;
  // Native screenshot protection
  disableNativeScreenshot: boolean;
  setDisableNativeScreenshot: (disabled: boolean) => void;
  // Debug console button position
  debugButtonPosition: DebugButtonPosition;
  setDebugButtonPosition: (position: DebugButtonPosition) => void;
  // App initialization state (whether app has checked for existing accounts)
  isInitialized: boolean;
  setIsInitialized: (value: boolean) => void;
  // Runtime-only fail-closed login routing after an unreadable import marker.
  lockedStartupFallback: boolean;
  setLockedStartupFallback: (value: boolean) => void;
  setSecureStartupRouting: (
    initialized: boolean,
    lockedFallback: boolean
  ) => void;
  // Durable authorization to continue first-install secure account creation
  // after provision-only dummy storage or a complete onboarding rollback.
  secureAccountCreationAllowed: boolean;
  setSecureAccountCreationAllowed: (value: boolean) => void;
  // Pending deep link
  pendingDeepLinkInfo: ParsedInvite | null;
  setPendingDeepLinkInfo: (value: ParsedInvite | null) => void;
  // Pending shared content from other apps
  pendingSharedContent: string | null;
  setPendingSharedContent: (content: string | null) => void;
  // Pending forward message id (used during discussion selection)
  pendingForwardMessageId: number | null;
  setPendingForwardMessageId: (messageId: number | null) => void;
  // Active encrypted account-settings owner (runtime-only).
  activeAccountSettingsUserId: string | null;
  accountSettingsGeneration: number;
  mnsRequestGeneration: number;
  // MNS support enabled/disabled
  mnsEnabled: boolean;
  setMnsEnabled: (enabled: boolean) => Promise<void>;
  // MNS domains cache
  mnsDomains: string[];
  setMnsDomains: (domains: string[]) => void;
  fetchMnsDomains: (
    userProfile: UserProfile | null,
    provider: Provider | null
  ) => Promise<void>;
  // Default retention duration for new discussions (seconds), null = off
  defaultRetentionDuration: number | null;
  setDefaultRetentionDuration: (duration: number | null) => Promise<void>;
  hydrateAccountSettings: (settings: AccountSettingsV1) => void;
  resetAccountSettings: () => void;
  // Auto-lock timeout (seconds), null = disabled
  autoLockTimeout: number | null;
  setAutoLockTimeout: (timeout: number | null) => void;
}

const useAppStoreBase = create<AppStoreState>()(
  persist(
    (set, get) => ({
      // Terms of Service acceptance
      tosAccepted: false,
      setTosAccepted: (value: boolean) => {
        set({ tosAccepted: value });
      },
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
      // Native screenshot protection (off by default)
      disableNativeScreenshot: false,
      setDisableNativeScreenshot: (disabled: boolean) => {
        set({ disableNativeScreenshot: disabled });
      },
      // Debug console button position (default: bottom-left)
      debugButtonPosition: { x: 8, y: 80 },
      setDebugButtonPosition: (position: DebugButtonPosition) => {
        set({ debugButtonPosition: position });
      },
      // App initialization state
      isInitialized: false,
      setIsInitialized: (value: boolean) => {
        set({ isInitialized: value });
      },
      lockedStartupFallback: false,
      setLockedStartupFallback: (value: boolean) => {
        set({ lockedStartupFallback: value });
      },
      setSecureStartupRouting: (initialized, lockedFallback) => {
        set({
          isInitialized: initialized,
          lockedStartupFallback: lockedFallback,
        });
      },
      secureAccountCreationAllowed: false,
      setSecureAccountCreationAllowed: (value: boolean) => {
        set({ secureAccountCreationAllowed: value });
      },
      // Pending deep link
      pendingDeepLinkInfo: null,
      setPendingDeepLinkInfo: (value: ParsedInvite | null) => {
        set({ pendingDeepLinkInfo: value });
      },
      // Pending shared content
      pendingSharedContent: null,
      setPendingSharedContent: (content: string | null) => {
        set({ pendingSharedContent: content });
      },
      // Pending forward message id
      pendingForwardMessageId: null,
      setPendingForwardMessageId: (messageId: number | null) => {
        set({ pendingForwardMessageId: messageId });
      },
      // Per-account encrypted settings (runtime defaults until login).
      activeAccountSettingsUserId: null,
      accountSettingsGeneration: 0,
      mnsRequestGeneration: 0,
      // MNS support (disabled by default)
      mnsEnabled: false,
      setMnsEnabled: async (enabled: boolean) => {
        const userId = get().activeAccountSettingsUserId;
        if (!userId) throw new Error('No active account settings');
        const { getSdk } = await import('./sdkStore');
        const settings = await getSdk().queries.accountSettings.update(userId, {
          mnsEnabled: enabled,
        });
        if (get().activeAccountSettingsUserId !== userId) return;
        set(state => ({
          mnsEnabled: settings.mnsEnabled,
          ...(!settings.mnsEnabled
            ? {
                mnsDomains: [],
                mnsRequestGeneration: state.mnsRequestGeneration + 1,
              }
            : {}),
        }));
      },
      // MNS domains cache
      mnsDomains: [],
      setMnsDomains: (domains: string[]) => {
        set({ mnsDomains: domains });
      },
      // Default retention duration for new discussions (1 month = 2592000s)
      defaultRetentionDuration: 2592000,
      setDefaultRetentionDuration: async (duration: number | null) => {
        const userId = get().activeAccountSettingsUserId;
        if (!userId) throw new Error('No active account settings');
        const { getSdk } = await import('./sdkStore');
        const settings = await getSdk().queries.accountSettings.update(userId, {
          defaultRetentionDuration: duration,
        });
        if (get().activeAccountSettingsUserId !== userId) return;
        set({
          defaultRetentionDuration: settings.defaultRetentionDuration,
        });
      },
      hydrateAccountSettings: settings => {
        set(state => ({
          activeAccountSettingsUserId: settings.userId,
          accountSettingsGeneration: state.accountSettingsGeneration + 1,
          mnsRequestGeneration: state.mnsRequestGeneration + 1,
          mnsEnabled: settings.mnsEnabled,
          defaultRetentionDuration: settings.defaultRetentionDuration,
          mnsDomains: [],
        }));
      },
      resetAccountSettings: () => {
        set(state => ({
          activeAccountSettingsUserId: null,
          accountSettingsGeneration: state.accountSettingsGeneration + 1,
          mnsRequestGeneration: state.mnsRequestGeneration + 1,
          mnsEnabled: false,
          defaultRetentionDuration: 2592000,
          mnsDomains: [],
        }));
      },
      // Auto-lock timeout (disabled by default)
      autoLockTimeout: null,
      setAutoLockTimeout: (timeout: number | null) => {
        set({ autoLockTimeout: timeout });
      },
      fetchMnsDomains: async (
        userProfile: UserProfile | null,
        provider: Provider | null
      ) => {
        const state = get();
        const userId = state.activeAccountSettingsUserId;
        const accountGeneration = state.accountSettingsGeneration;
        if (!userId || userProfile?.userId !== userId) return;
        if (!state.mnsEnabled || !provider) {
          set(current => ({
            mnsDomains: [],
            mnsRequestGeneration: current.mnsRequestGeneration + 1,
          }));
          return;
        }
        const requestGeneration = state.mnsRequestGeneration + 1;
        set({ mnsRequestGeneration: requestGeneration });

        const requestIsCurrent = () => {
          const current = get();
          return (
            current.activeAccountSettingsUserId === userId &&
            current.accountSettingsGeneration === accountGeneration &&
            current.mnsRequestGeneration === requestGeneration &&
            current.mnsEnabled
          );
        };
        try {
          const domains = await mnsService.getDomainsFromGossipId(userId);
          const domainsWithSuffix = domains.map(domain => `${domain}.massa`);
          if (requestIsCurrent()) set({ mnsDomains: domainsWithSuffix });
        } catch (error) {
          logger.error('Error fetching MNS domains:', error);
          if (requestIsCurrent()) set({ mnsDomains: [] });
        }
      },
    }),
    {
      name: STORAGE_KEYS.APP_STORE,
      version: 1,
      storage: createJSONStorage(() => localStorage),
      migrate: persisted => {
        if (typeof persisted !== 'object' || persisted === null) return {};
        const localState = {
          ...(persisted as Record<string, unknown>),
        };
        delete localState.mnsEnabled;
        delete localState.mnsDomains;
        delete localState.defaultRetentionDuration;
        return localState;
      },
      partialize: state => ({
        tosAccepted: state.tosAccepted,
        showDebugOption: state.showDebugOption,
        debugOverlayVisible: state.debugOverlayVisible,
        debugButtonPosition: state.debugButtonPosition,
        isInitialized: state.isInitialized,
        secureAccountCreationAllowed: state.secureAccountCreationAllowed,
        networkName: state.networkName,
        disableNativeScreenshot: state.disableNativeScreenshot,
        autoLockTimeout: state.autoLockTimeout,
      }),
    }
  )
);

export const useAppStore = createSelectors(useAppStoreBase);
