import { useEffect, useState } from 'react';
import { db } from '../db';
import { STORAGE_KEYS, clearAppStorage } from '../utils/localStorage';
import { useLocalStorage } from './useLocalStorage';
import { APP_BUILD_ID } from '../config/version';

export function useVersionCheck() {
  const [buildId, setBuildId] = useLocalStorage<string | null>(
    STORAGE_KEYS.APP_BUILD_ID,
    null
  );
  const [showUpdatePrompt, setShowUpdatePrompt] = useState(false);

  useEffect(() => {
    if (buildId === null) {
      // First load → set current version but don't show prompt
      setBuildId(APP_BUILD_ID);
    } else if (buildId !== APP_BUILD_ID) {
      // Version changed → show update prompt
      setShowUpdatePrompt(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildId]);

  const isVersionDifferent = buildId !== null && buildId !== APP_BUILD_ID;

  const dismissUpdate = () => {
    setShowUpdatePrompt(false);
  };

  const handleForceUpdate = async () => {
    try {
      // 1. Clear all caches
      const cacheNames = await caches.keys();
      await Promise.all(cacheNames.map(name => caches.delete(name)));

      // 2. Remove IndexedDB databases
      await db.deleteDb();

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
    }
  };

  return {
    showUpdatePrompt,
    handleForceUpdate,
    isVersionDifferent,
    dismissUpdate,
  };
}
