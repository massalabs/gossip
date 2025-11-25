import { useState, useEffect } from 'react';
import {
  StorageKey,
  getStorageItem,
  setStorageItem,
} from '../utils/localStorage';

/**
 * React hook for localStorage with automatic state synchronization
 * Automatically syncs localStorage with React state
 * Uses centralized StorageKey type for type safety
 *
 * @example
 * ```tsx
 * const [buildId, setBuildId] = useLocalStorage(STORAGE_KEYS.APP_BUILD_ID, 'dev-local');
 * ```
 */
export function useLocalStorage<T>(
  storageKey: StorageKey,
  fallbackState: T
): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    if (typeof window === 'undefined') return fallbackState;
    const stored = getStorageItem<T>(storageKey);
    return stored ?? fallbackState;
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    setStorageItem(storageKey, value);
  }, [storageKey, value]);

  return [value, setValue];
}
