import { useEffect } from 'react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { useAccountStore } from '../stores/accountStore';

/**
 * Tells the user once, inside the account, that its messaging sessions were
 * given up because it was restored from a backup, and that the contacts are
 * being reconnected. The mark lives in the account's encrypted storage only.
 */
export function useSessionsResetNotice(): void {
  const { t } = useTranslation('auth');
  const signedIn = useAccountStore(s => s.userProfile !== null);
  const pending = useAccountStore(s => s.sessionsResetNotice);
  const acknowledge = useAccountStore(s => s.acknowledgeSessionsResetNotice);

  useEffect(() => {
    if (!signedIn || !pending) return;
    toast(t('private_migration.sessions_reset'), { duration: 8000 });
    void acknowledge();
  }, [signedIn, pending, acknowledge, t]);
}
