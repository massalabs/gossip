import { useCallback, useEffect } from 'react';
import { STORAGE_KEYS, clearAppStorage } from '../utils/localStorage';
import { useLocalStorage } from './useLocalStorage';
import { APP_BUILD_ID } from '../config/version';
import { useGossipSdk } from './useGossipSdk';

export function useVersionCheck() {
  const gossip = useGossipSdk();
  const [buildId, setBuildId] = useLocalStorage<string | null>(
    STORAGE_KEYS.APP_BUILD_ID,
    null
  );

  useEffect(() => {
    if (buildId === null) {
      setBuildId(APP_BUILD_ID);
    } else if (buildId !== APP_BUILD_ID) {
      // Version changed → show update prompt
    }
  }, [buildId, setBuildId]);

  const isVersionDifferent = buildId !== null && buildId !== APP_BUILD_ID;

  const handleForceUpdate = useCallback(async () => {
    try {
      const cacheNames = await caches.keys();
      await Promise.all(cacheNames.map(name => caches.delete(name)));

      try {
        await gossip.clearAllTables();
        await gossip.destroy();
      } catch {
        // SQLite might not be initialized
      }

      clearAppStorage();

      const registrations = await navigator.serviceWorker.getRegistrations();
      for (const reg of registrations) {
        await reg.unregister();
      }

      window.location.reload();
    } catch (err) {
      console.error('Clean failed:', err);
      window.location.reload();
    } finally {
      setBuildId(APP_BUILD_ID);
    }
  }, [gossip, setBuildId]);

  return {
    handleForceUpdate,
    isVersionDifferent,
  };
}
