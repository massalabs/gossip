/**
 * Centralized localStorage management
 * Single source of truth for all localStorage keys used in the app
 */

// Define all localStorage keys used in the app
export const STORAGE_KEYS = {
  APP_BUILD_ID: 'appBuildId',
  THEME: 'gossip-theme',
  APP_STORE: 'app-store', // Zustand persist key
} as const;

export type StorageKey = (typeof STORAGE_KEYS)[keyof typeof STORAGE_KEYS];

/**
 * Get all app-specific localStorage keys
 */
export const getAppStorageKeys = (): readonly string[] => {
  return Object.values(STORAGE_KEYS);
};

/**
 * Get a value from localStorage
 */
export const getStorageItem = <T = string>(key: StorageKey): T | null => {
  if (typeof window === 'undefined') return null;
  try {
    const item = localStorage.getItem(key);
    if (item === null) return null;
    // Try to parse as JSON, fallback to string
    try {
      return JSON.parse(item) as T;
    } catch {
      return item as T;
    }
  } catch (error) {
    console.error(`Error getting localStorage item "${key}":`, error);
    return null;
  }
};

/**
 * Set a value in localStorage
 */
export const setStorageItem = <T = string>(key: StorageKey, value: T): void => {
  if (typeof window === 'undefined') return;
  try {
    const serialized =
      typeof value === 'string' ? value : JSON.stringify(value);
    localStorage.setItem(key, serialized);
  } catch (error) {
    console.error(`Error setting localStorage item "${key}":`, error);
  }
};

/**
 * Remove a specific key from localStorage
 */
export const removeStorageItem = (key: StorageKey): void => {
  if (typeof window === 'undefined') return;
  try {
    localStorage.removeItem(key);
  } catch (error) {
    console.error(`Error removing localStorage item "${key}":`, error);
  }
};

/**
 * Clear all app-specific localStorage keys
 */
export const clearAppStorage = (): void => {
  if (typeof window === 'undefined') return;
  const keys = getAppStorageKeys();
  keys.forEach(key => {
    try {
      localStorage.removeItem(key);
    } catch (error) {
      console.error(`Error removing localStorage item "${key}":`, error);
    }
  });
};
