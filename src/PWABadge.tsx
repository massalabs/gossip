import './PWABadge.css';

import { useEffect, useRef } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import Button from './components/ui/Button';

function PWABadge() {
  // check for updates every hour
  const period = 60 * 60 * 1000;
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  const {
    offlineReady: [offlineReady, setOfflineReady],
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(swUrl, r) {
      if (period <= 0) return;
      if (r?.active?.state === 'activated') {
        intervalRef.current = registerPeriodicSync(period, swUrl, r);
      } else if (r?.installing) {
        r.installing.addEventListener('statechange', e => {
          const sw = e.target as ServiceWorker;
          if (sw.state === 'activated') {
            intervalRef.current = registerPeriodicSync(period, swUrl, r);
          }
        });
      }
    },
  });

  useEffect(() => {
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, []);

  function close() {
    setOfflineReady(false);
    setNeedRefresh(false);
  }

  return (
    <div className="PWABadge" role="alert" aria-labelledby="toast-message">
      {(offlineReady || needRefresh) && (
        <div className="PWABadge-toast">
          <div className="PWABadge-message">
            {offlineReady ? (
              <span id="toast-message">App ready to work offline</span>
            ) : (
              <span id="toast-message">
                New content available, click on reload button to update.
              </span>
            )}
          </div>
          <div className="PWABadge-buttons">
            {needRefresh && (
              <Button
                className="PWABadge-toast-button"
                onClick={() => updateServiceWorker(true)}
                variant="ghost"
                size="custom"
              >
                Reload
              </Button>
            )}
            <Button
              className="PWABadge-toast-button"
              onClick={() => close()}
              variant="ghost"
              size="custom"
            >
              Close
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export default PWABadge;

/**
 * This function will register a periodic sync check every hour, you can modify the interval as needed.
 * @returns The interval ID that can be used to clear the interval
 */
function registerPeriodicSync(
  period: number,
  swUrl: string,
  r: ServiceWorkerRegistration
): NodeJS.Timeout | null {
  if (period <= 0) return null;

  const intervalId = setInterval(async () => {
    if ('onLine' in navigator && !navigator.onLine) return;

    const resp = await fetch(swUrl, {
      cache: 'no-store',
      headers: {
        cache: 'no-store',
        'cache-control': 'no-cache',
      },
    });

    if (resp?.status === 200) await r.update();
  }, period);

  return intervalId;
}
