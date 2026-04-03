import { useEffect, useRef } from 'react';
import { useAccountStore } from '../stores/accountStore';
import { UserProfile } from '@massalabs/gossip-sdk';

/**
 * Dev-only hook: auto-login with VITE_DEV_PASSWORD on hot reload.
 * If no account exists but VITE_DEV_ACCOUNTS is set, triggers the dev account picker.
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

  const lockedByUser = useAccountStore(s => s.lockedByUser);

  useEffect(() => {
    if (!import.meta.env.DEV) return;

    const devPassword = import.meta.env.VITE_DEV_PASSWORD;
    if (!devPassword || attempted.current || !account || lockedByUser) return;

    attempted.current = true;
    callbacks.setLoading(true);

    loadAccount({
      type: 'password',
      password: devPassword,
      userId: account.userId,
    })
      .then(() => {
        if (useAccountStore.getState().userProfile) {
          callbacks.onSuccess();
        }
      })
      .catch(err => {
        console.error('[dev-auto-login] failed:', err);
        callbacks.onError('Dev auto-login failed');
      })
      .finally(() => callbacks.setLoading(false));
  }, [account, lockedByUser, loadAccount, callbacks]);
}

export interface DevAccount {
  name: string;
  mnemonic: string;
}

/**
 * Parse VITE_DEV_ACCOUNTS env var.
 * Format: JSON array of {name, mnemonic} objects.
 */
export function getDevAccounts(): DevAccount[] {
  if (!import.meta.env.DEV) return [];
  const raw = import.meta.env.VITE_DEV_ACCOUNTS;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (a: unknown): a is DevAccount =>
        typeof a === 'object' &&
        a !== null &&
        typeof (a as DevAccount).name === 'string' &&
        typeof (a as DevAccount).mnemonic === 'string'
    );
  } catch {
    console.error('[dev] Failed to parse VITE_DEV_ACCOUNTS');
    return [];
  }
}
