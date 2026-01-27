import { create } from 'zustand';
import { createSelectors } from './utils/createSelectors';
import { Result } from '@massalabs/gossip-sdk';

export enum SyncKey {
  RESEND_ANNOUNCEMENT = 'resend announcement',
  FETCH_ANNOUNCEMENT = 'fetch announcement',
}

export class SyncKeyNotFreeError extends Error {
  notAvailableSyncKeys: SyncKey[];
  error?: Error;
  constructor(notAvailableSyncKeys: SyncKey[], error?: Error) {
    super(
      notAvailableSyncKeys.length > 0
        ? `Sync keys not free: ${notAvailableSyncKeys.join(', ')}`
        : error
          ? error.message
          : 'Sync keys not free'
    );

    this.name = 'SyncKeyNotFreeError';
    this.notAvailableSyncKeys = notAvailableSyncKeys;
    this.error = error;

    // Set the prototype explicitly (for Error inheritance with transpilation)
    Object.setPrototypeOf(this, SyncKeyNotFreeError.prototype);
  }
}

interface SyncStoreState {
  isRunning: Record<SyncKey, boolean>;
  areRunning: (syncKeys: SyncKey[]) => boolean;
  executeIfLockFree: <T>(
    acquireSyncKeys: SyncKey[],
    notRunningSyncKeys: SyncKey[],
    fn: () => Promise<T>
  ) => Promise<Result<T, Error>>;
}

const useSyncStoreBase = create<SyncStoreState>((set, get) => ({
  isRunning: {
    [SyncKey.RESEND_ANNOUNCEMENT]: false,
    [SyncKey.FETCH_ANNOUNCEMENT]: false,
  },

  areRunning: (syncKeys: SyncKey[]): boolean => {
    if (syncKeys.length === 0) return false;
    const { isRunning } = get();
    return syncKeys.every(key => isRunning[key]);
  },

  executeIfLockFree: async <T,>(
    acquireSyncKeys: SyncKey[],
    notRunningSyncKeys: SyncKey[],
    fn: () => Promise<T>
  ): Promise<Result<T, Error>> => {
    const { isRunning } = get();

    // Check if any of the keys are not running
    if (notRunningSyncKeys.some(key => isRunning[key])) {
      return {
        success: false,
        error: new SyncKeyNotFreeError(notRunningSyncKeys),
      };
    }

    // Acquire locks for all keys
    set(state => {
      const newIsRunning = { ...state.isRunning };
      acquireSyncKeys.forEach(key => {
        newIsRunning[key] = true;
      });
      return { isRunning: newIsRunning };
    });

    // Execute the function and ensure locks are released
    try {
      const result = await fn();
      return { success: true, data: result };
    } catch (error) {
      return {
        success: false,
        error: new SyncKeyNotFreeError(
          [],
          error instanceof Error ? error : new Error(String(error))
        ),
      };
    } finally {
      // Release locks for all keys (always executes, even if function throws or returns)
      set(state => {
        const newIsRunning = { ...state.isRunning };
        acquireSyncKeys.forEach(key => {
          newIsRunning[key] = false;
        });
        return { isRunning: newIsRunning };
      });
    }
  },
}));

export const useSyncStore = createSelectors(useSyncStoreBase);
