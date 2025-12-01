import { useEffect } from 'react';
import { useNetworkStore } from '../stores/networkStore';

/**
 * Hook that wires browser online/offline events into the global network store.
 * Call once at app startup (e.g. in AppContent) to keep network status in sync.
 */
export function useNetworkStatus(): void {
  const setIsOnline = useNetworkStore(s => s.setIsOnline);

  useEffect(() => {
    // Set initial status
    if (
      typeof navigator !== 'undefined' &&
      typeof navigator.onLine === 'boolean'
    ) {
      setIsOnline(navigator.onLine);
    }

    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [setIsOnline]);
}
