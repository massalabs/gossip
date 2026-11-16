import { useEffect } from 'react';
import { SECURE_STORAGE_ENABLED } from '../config/features';
import { useAccountStore } from '../stores/accountStore';
import { useRekeyStore } from '../stores/rekeyStore';
import {
  holdSessionPresence,
  waitForRekeyEnd,
  watchRekeyElsewhere,
} from '../services/rekeyTabs';
import { logger } from '../utils/logger.ts';

/**
 * This window's side of the cross-window rule in `services/rekeyTabs.ts`:
 * advertise an open account, and step aside when another window rekeys.
 */
export function useRekeyCoordination(): void {
  const accountOpen = useAccountStore(state => state.userProfile !== null);

  useEffect(() => {
    if (!SECURE_STORAGE_ENABLED || !accountOpen) return;
    return holdSessionPresence();
  }, [accountOpen]);

  useEffect(() => {
    if (!SECURE_STORAGE_ENABLED) return;
    return watchRekeyElsewhere(() => {
      const rekey = useRekeyStore.getState();
      // This window's own rekey, or already stepping aside.
      if (rekey.status !== 'idle') return;
      rekey.setStatus('elsewhere');
      void (async () => {
        try {
          if (useAccountStore.getState().userProfile) {
            await useAccountStore.getState().logout({ lockedByUser: false });
          }
        } catch (error) {
          logger.error(
            'Could not log out for a rekey in another window:',
            error
          );
        }
        await waitForRekeyEnd();
        // This window's copy of storage is the old generation.
        window.location.reload();
      })();
    });
  }, []);
}
