import { Capacitor } from '@capacitor/core';
import { useAppStore } from '../stores/appStore';
import { STORAGE_KEYS } from '../utils/localStorage';
import type { PortableImportAuthorization } from './portableImportCoordinator';

const AUTHORITY_CONSUMED_KEY = 'gossip:portable-import-authority-consumed-v1';
const CREATION_COMMITTED_KEY = 'gossip:onboarding-creation-committed-v1';
const ONBOARDING_MODE_KEY = 'gossip:onboarding-storage-mode-v1';
const ONBOARDING_MODE_LOCK = 'gossip-onboarding-storage-mode-v1';
type OnboardingStorageMode = 'create' | 'import';
let nativeModeTail: Promise<void> = Promise.resolve();
const leaseOwners = new WeakMap<
  OnboardingStorageModeLease,
  { mode: OnboardingStorageMode; owner: string }
>();
interface OnboardingModeRecord {
  mode?: unknown;
  owner?: unknown;
}

function durableStorage(): Storage | null {
  if (typeof window !== 'undefined') return window.localStorage;
  if (typeof localStorage !== 'undefined') return localStorage;
  return null;
}

async function acquireNativeModeMutex(): Promise<() => void> {
  const previous = nativeModeTail;
  let release!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  nativeModeTail = previous.then(
    () => gate,
    () => gate
  );
  await previous.catch(() => {});
  return release;
}

async function withOnboardingModeLock<T>(
  operation: () => T | Promise<T>
): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return await navigator.locks.request(
      ONBOARDING_MODE_LOCK,
      { mode: 'exclusive' },
      operation
    );
  }
  // Browser claims fail closed without Web Locks. Native uses an in-process
  // mutex because its one webview can still interleave async startup work.
  if (Capacitor.isNativePlatform()) {
    const release = await acquireNativeModeMutex();
    try {
      return await operation();
    } finally {
      release();
    }
  }
  return await operation();
}

export function portableImportAuthorityWasConsumed(): boolean {
  return durableStorage()?.getItem(AUTHORITY_CONSUMED_KEY) === 'consumed';
}

export function isOnboardingStorageCreationAuthorized(): boolean {
  const durable = readDurableAuthority();
  return (
    durableStorage()?.getItem(CREATION_COMMITTED_KEY) === null &&
    !portableImportAuthorityWasConsumed() &&
    !durable.isInitialized &&
    durable.secureAccountCreationAllowed
  );
}

export function consumeOnboardingCreationAuthority(
  lease: OnboardingStorageModeLease | undefined
): string {
  const storage = durableStorage();
  const rawMode = storage?.getItem(ONBOARDING_MODE_KEY);
  let mode: OnboardingModeRecord | null = null;
  try {
    mode = rawMode ? (JSON.parse(rawMode) as OnboardingModeRecord) : null;
  } catch {
    mode = null;
  }
  const leaseOwner = lease ? leaseOwners.get(lease) : undefined;
  if (
    leaseOwner?.mode !== 'create' ||
    mode?.mode !== 'create' ||
    typeof mode.owner !== 'string' ||
    leaseOwner.owner !== mode.owner ||
    !isOnboardingStorageCreationAuthorized()
  ) {
    throw new Error('Secure account creation is not currently authorized');
  }
  storage?.setItem(
    CREATION_COMMITTED_KEY,
    JSON.stringify({ owner: mode.owner })
  );
  return mode.owner;
}

export function restoreOnboardingCreationAuthorityAfterRollback(
  owner: string | null
): void {
  if (!owner) return;
  const storage = durableStorage();
  try {
    const committed = JSON.parse(
      storage?.getItem(CREATION_COMMITTED_KEY) ?? 'null'
    ) as { owner?: unknown } | null;
    const mode = JSON.parse(
      storage?.getItem(ONBOARDING_MODE_KEY) ?? 'null'
    ) as { mode?: unknown; owner?: unknown } | null;
    if (
      committed?.owner !== owner ||
      mode?.mode !== 'create' ||
      mode.owner !== owner
    ) {
      return;
    }
  } catch {
    return;
  }
  const state = useAppStore.getState();
  state.setSecureAccountCreationAllowed(true);
  storage?.removeItem(CREATION_COMMITTED_KEY);
}

export async function reconcilePortableImportAuthority(
  readImported: () => Promise<boolean>,
  storageState: 'empty' | 'locked' | 'unlocked' | null
): Promise<void> {
  await withOnboardingModeLock(async () => {
    const imported = await readImported();
    const durable = readDurableAuthority();
    const state = useAppStore.getState();
    if (
      imported ||
      durable.isInitialized ||
      durableStorage()?.getItem(CREATION_COMMITTED_KEY) !== null
    ) {
      state.setSecureAccountCreationAllowed(false);
      return;
    }
    if (
      storageState === 'empty' ||
      durable.secureAccountCreationAllowed ||
      portableImportAuthorityWasConsumed()
    ) {
      // Persist restoration before deleting its recovery proof.
      state.setSecureAccountCreationAllowed(true);
      const storage = durableStorage();
      storage?.removeItem(AUTHORITY_CONSUMED_KEY);
      storage?.removeItem(ONBOARDING_MODE_KEY);
    }
  });
}

export interface OnboardingStorageModeLease {
  release(): Promise<void>;
}

export async function claimOnboardingStorageMode(
  mode: OnboardingStorageMode
): Promise<OnboardingStorageModeLease> {
  const owner = crypto.randomUUID();
  const claim = () => {
    const storage = durableStorage();
    if (storage?.getItem(ONBOARDING_MODE_KEY) !== null) {
      throw new Error('Another onboarding storage operation already started');
    }
    storage?.setItem(ONBOARDING_MODE_KEY, JSON.stringify({ mode, owner }));
  };
  const clearOwnedMode = () => {
    const storage = durableStorage();
    const raw = storage?.getItem(ONBOARDING_MODE_KEY);
    if (raw === null || raw === undefined) return;
    try {
      if ((JSON.parse(raw) as { owner?: unknown }).owner === owner) {
        storage?.removeItem(ONBOARDING_MODE_KEY);
      }
    } catch {
      // A malformed or foreign claim is never removed by this owner.
    }
  };

  if (typeof navigator !== 'undefined' && navigator.locks) {
    let releaseLock!: () => void;
    let resolveLease!: (lease: OnboardingStorageModeLease) => void;
    let rejectLease!: (error: unknown) => void;
    const lease = new Promise<OnboardingStorageModeLease>((resolve, reject) => {
      resolveLease = resolve;
      rejectLease = reject;
    });
    const holding = navigator.locks.request(
      ONBOARDING_MODE_LOCK,
      { mode: 'exclusive' },
      async () => {
        claim();
        const released = new Promise<void>(resolve => {
          releaseLock = resolve;
        });
        const ownedLease: OnboardingStorageModeLease = {
          release: async () => {
            releaseLock();
            await holding;
          },
        };
        leaseOwners.set(ownedLease, { mode, owner });
        resolveLease(ownedLease);
        await released;
        clearOwnedMode();
      }
    );
    void holding.catch(rejectLease);
    return lease;
  }

  if (!Capacitor.isNativePlatform()) {
    throw new Error('Exclusive onboarding storage ownership is unavailable');
  }
  const releaseMutex = await acquireNativeModeMutex();
  try {
    claim();
  } catch (error) {
    releaseMutex();
    throw error;
  }
  let released = false;
  const ownedLease: OnboardingStorageModeLease = {
    release: async () => {
      if (released) return;
      released = true;
      clearOwnedMode();
      releaseMutex();
    },
  };
  leaseOwners.set(ownedLease, { mode, owner });
  return ownedLease;
}

interface DurableAppStore {
  state?: {
    isInitialized?: unknown;
    secureAccountCreationAllowed?: unknown;
    [key: string]: unknown;
  };
  version?: unknown;
  [key: string]: unknown;
}

function readDurableAuthority(): {
  isInitialized: boolean;
  secureAccountCreationAllowed: boolean;
  persisted: DurableAppStore | null;
} {
  const storage = durableStorage();
  if (storage) {
    if (storage.getItem(AUTHORITY_CONSUMED_KEY) === 'consumed') {
      return {
        isInitialized: false,
        secureAccountCreationAllowed: false,
        persisted: null,
      };
    }
    const raw = storage.getItem(STORAGE_KEYS.APP_STORE);
    if (raw !== null) {
      try {
        const persisted = JSON.parse(raw) as DurableAppStore;
        if (typeof persisted.state === 'object' && persisted.state !== null) {
          return {
            isInitialized: persisted.state.isInitialized === true,
            secureAccountCreationAllowed:
              persisted.state.secureAccountCreationAllowed === true,
            persisted,
          };
        }
      } catch {
        return {
          isInitialized: true,
          secureAccountCreationAllowed: false,
          persisted: null,
        };
      }
    }
  }
  const state = useAppStore.getState();
  return {
    isInitialized: state.isInitialized,
    secureAccountCreationAllowed: state.secureAccountCreationAllowed,
    persisted: null,
  };
}

/**
 * Authorize replacement only while the durable first-install grant is active.
 * Authority is consumed before physical installation. If installation has not
 * committed when the process dies, authoritative empty storage recreates the
 * first-install grant on startup; committed locked storage never does.
 */
export function createOnboardingPortableImportAuthorization(): PortableImportAuthorization {
  let lease: OnboardingStorageModeLease | null = null;
  return {
    claim: async () => {
      if (!lease) lease = await claimOnboardingStorageMode('import');
    },
    release: async () => {
      const owned = lease;
      lease = null;
      await owned?.release();
    },
    isAuthorized: () => {
      if (!lease) return false;
      const durable = readDurableAuthority();
      return (
        durableStorage()?.getItem(CREATION_COMMITTED_KEY) === null &&
        !durable.isInitialized &&
        durable.secureAccountCreationAllowed
      );
    },
    prepareCommit: () => {
      const durable = readDurableAuthority();
      if (
        !lease ||
        durable.isInitialized ||
        !durable.secureAccountCreationAllowed
      ) {
        throw new Error('Portable import is not currently authorized');
      }
      const storage = durableStorage();
      if (storage) {
        // This monotonic record cannot be resurrected by another tab writing
        // an old whole-store Zustand snapshot.
        storage.setItem(AUTHORITY_CONSUMED_KEY, 'consumed');
      }
      if (storage && durable.persisted?.state) {
        try {
          storage.setItem(
            STORAGE_KEYS.APP_STORE,
            JSON.stringify({
              ...durable.persisted,
              state: {
                ...durable.persisted.state,
                secureAccountCreationAllowed: false,
              },
            })
          );
        } catch {
          // The monotonic authority record is the security boundary.
        }
      }
      try {
        useAppStore.getState().setSecureAccountCreationAllowed(false);
      } catch {
        // In-memory synchronization is best effort after durable consumption.
      }
    },
    commitSuccess: () => {
      // Replacement authority was durably consumed before installation.
    },
  };
}
