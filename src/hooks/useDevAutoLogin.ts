import { UserProfile } from '@massalabs/gossip-sdk';

// TEMP: the dev signup/login path (auto-login + dev-account picker) is
// disabled while it gets reworked against the secure-storage onboarding
// flow. Both exports are kept as no-ops so call-sites (Onboarding.tsx,
// Login/useLoginForm.ts) compile without changes — re-enable by
// restoring the original implementations from git history (last good
// version on `secure-storage/4-android-build`).

/**
 * Dev-only hook: auto-login with VITE_DEV_PASSWORD on hot reload.
 * Currently a no-op. See top-of-file comment.
 */
export function useDevAutoLogin(
  _account: UserProfile | null | undefined,
  _callbacks: {
    onSuccess: () => void;
    onError: (msg: string) => void;
    setLoading: (v: boolean) => void;
  }
): void {
  // intentionally empty
}

export interface DevAccount {
  name: string;
  mnemonic: string;
}

/**
 * Parse VITE_DEV_ACCOUNTS env var. Currently returns an empty list so
 * Onboarding falls through to the normal slideshow + secure-storage
 * signup flow. See top-of-file comment.
 */
export function getDevAccounts(): DevAccount[] {
  return [];
}
