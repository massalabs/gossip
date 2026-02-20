import { useEffect } from 'react';
import { clearAllTables, closeSqlite } from '@massalabs/gossip-sdk';
import { STORAGE_KEYS, clearAppStorage } from '../utils/localStorage';
import { useLocalStorage } from './useLocalStorage';
import { APP_BUILD_ID } from '../config/version';

export function useVersionCheck() {
  const [buildId, setBuildId] = useLocalStorage<string | null>(
    STORAGE_KEYS.APP_BUILD_ID,
    null
  );

  useEffect(() => {
    if (buildId === null) {
      // First load → set current version but don't show prompt
      setBuildId(APP_BUILD_ID);
    } else if (buildId !== APP_BUILD_ID) {
      // Version changed → show update prompt
    }
  }, [buildId, setBuildId]);

  const isVersionDifferent = buildId !== null && buildId !== APP_BUILD_ID;

  const handleForceUpdate = async () => {
    try {
      // 1. Clear all caches
      const cacheNames = await caches.keys();
      await Promise.all(cacheNames.map(name => caches.delete(name)));

      // 2. Clear SQLite data and close
      try {
        await clearAllTables();
        await closeSqlite();
      } catch {
        // SQLite might not be initialized
      }

      // 3. Clear app-specific localStorage keys
      clearAppStorage();

      // 4. Unregister service workers
      const registrations = await navigator.serviceWorker.getRegistrations();
      for (const reg of registrations) {
        await reg.unregister();
      }

      // 5. Reload the page → everything will be fresh
      window.location.reload();
    } catch (err) {
      console.error('Clean failed:', err);
      window.location.reload();
    } finally {
      setBuildId(APP_BUILD_ID);
    }
  };

  return {
    handleForceUpdate,
    isVersionDifferent,
  };
}
