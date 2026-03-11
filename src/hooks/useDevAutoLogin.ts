import { useEffect, useRef } from 'react';
import { useAccountStore } from '../stores/accountStore';
import { UserProfile } from '@massalabs/gossip-sdk';

/**
 * Dev-only hook: auto-login with VITE_DEV_PASSWORD on hot reload.
 * Tree-shaken out of production builds (guarded by import.meta.env.DEV).
 */
export function useDevAutoLogin(
  account: UserProfile | null | undefined,
  callbacks: {
    onSuccess: () => void;
    onError: (msg: string) => void;
    setLoading: (v: boolean) => void;
  }
) {
  const attempted = useRef(false);
  const loadAccount = useAccountStore(s => s.loadAccount);

  useEffect(() => {
    if (!import.meta.env.DEV) return;

    const devPassword = import.meta.env.VITE_DEV_PASSWORD;
    if (!devPassword || attempted.current || !account) return;

    attempted.current = true;
    callbacks.setLoading(true);

    loadAccount(devPassword, account.userId)
      .then(() => {
        if (useAccountStore.getState().userProfile) {
          callbacks.onSuccess();
        }
      })
      .catch(err => {
        console.error('[dev-auto-login] failed:', err);
        callbacks.onError('Dev auto-login failed. Check VITE_DEV_PASSWORD.');
      })
      .finally(() => callbacks.setLoading(false));
  }, [account, loadAccount, callbacks]);
}
