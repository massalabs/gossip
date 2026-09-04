import { logger } from '../utils/logger.ts';
import { useCallback, useRef, useState } from 'react';
import { validateUserIdFormat, UserPublicKeys } from '@massalabs/gossip-sdk';
import { useAccountStore } from '../stores/accountStore';
import { useAppStore } from '../stores/appStore';
import { useGossipSdk } from './useGossipSdk';
import { mnsService, isMnsDomain } from '../services/mns';

export type FieldState = {
  value: string;
  error?: string;
  loading: boolean;
};

export type MnsState = {
  /** Whether an MNS domain resolution is in progress */
  isResolving: boolean;
  /** The resolved gossip ID (if successful) */
  resolvedGossipId: string | null;
  /** The original MNS domain that was resolved */
  resolvedDomain: string | null;
};

/**
 * Turns raw user-ID input into a resolved gossip ID plus its public keys:
 * validates the format, resolves MNS domains (name.massa) when enabled,
 * fetches/caches the public keys and rejects IDs already in contacts.
 */
export function useUserIdResolution() {
  const gossip = useGossipSdk();
  const userProfile = useAccountStore(s => s.userProfile);
  const mnsEnabled = useAppStore(s => s.mnsEnabled);

  const publicKeysCache = useRef<Map<string, UserPublicKeys>>(new Map());

  // Sequence counter so stale async lookups can't overwrite newer input
  const requestSeqRef = useRef(0);

  const [userId, setUserId] = useState<FieldState>({
    value: '',
    loading: false,
  });

  const [publicKeys, setPublicKeys] = useState<UserPublicKeys | null>(null);

  const [mnsState, setMnsState] = useState<MnsState>({
    isResolving: false,
    resolvedGossipId: null,
    resolvedDomain: null,
  });

  const getPublicKey = useCallback(
    async (uid: string): Promise<UserPublicKeys> => {
      const cached = publicKeysCache.current.get(uid);

      if (cached) {
        return cached;
      }

      // Check if SDK is initialized before accessing auth service
      if (!gossip.isInitialized) {
        throw new Error('SDK not initialized');
      }

      const publicKey = await gossip.auth.fetchPublicKeyByUserId(uid);
      publicKeysCache.current.set(uid, publicKey);
      return publicKey;
    },
    [gossip.auth, gossip.isInitialized]
  );

  // Lets external flows (e.g. file import) seed already-known keys
  const cachePublicKey = useCallback((uid: string, keys: UserPublicKeys) => {
    publicKeysCache.current.set(uid, keys);
  }, []);

  // Shared tail of both branches (MNS-resolved ID and plain gossip ID):
  // fetch the public key, reject IDs already in contacts, publish the
  // result. `seq` is re-checked after every await so a stale lookup
  // can't overwrite newer input.
  const fetchAndValidateId = useCallback(
    async (id: string, seq: number) => {
      try {
        const publicKey = await getPublicKey(id);
        if (seq !== requestSeqRef.current) return;

        const existing = await gossip.contacts.get(id);
        if (seq !== requestSeqRef.current) return;
        if (existing) {
          setUserId(prev => ({
            ...prev,
            error: 'This user is already in your contacts',
            loading: false,
          }));
          return;
        }

        setPublicKeys(publicKey);
        setUserId(prev => ({ ...prev, loading: false }));
      } catch (error) {
        if (seq !== requestSeqRef.current) return;
        logger.error('Failed to fetch public key:', error);
        setUserId(prev => ({
          ...prev,
          error: 'Unable to load public key for this user ID. Please check it.',
          loading: false,
        }));
      }
    },
    [getPublicKey, gossip.contacts]
  );

  const handleUserIdChange = useCallback(
    async (value: string) => {
      const trimmed = value.trim();
      const seq = ++requestSeqRef.current;

      setPublicKeys(null);
      setUserId(prev => ({ ...prev, value: trimmed }));
      setMnsState({
        isResolving: false,
        resolvedGossipId: null,
        resolvedDomain: null,
      });

      if (!trimmed) return;
      // Check if the input looks like an MNS domain (ends with .massa)
      // Only resolve MNS domains if MNS support is enabled
      if (mnsEnabled && isMnsDomain(trimmed)) {
        setUserId(prev => ({
          ...prev,
          error: undefined,
          loading: true,
        }));
        setMnsState(prev => ({ ...prev, isResolving: true }));

        // Resolve MNS domain to gossip ID
        const mnsResult = await mnsService.resolveToGossipId(trimmed);
        if (seq !== requestSeqRef.current) return;

        if (!mnsResult.success) {
          setUserId(_ => ({
            value: trimmed,
            error: mnsResult.error,
            loading: false,
          }));
          setMnsState({
            isResolving: false,
            resolvedGossipId: null,
            resolvedDomain: null,
          });
          return;
        }

        const resolvedGossipId = mnsResult.gossipId;

        // Prevent adding own user ID as a contact
        if (userProfile?.userId && resolvedGossipId === userProfile.userId) {
          setUserId(_ => ({
            value: trimmed,
            error: 'You cannot add yourself as a contact',
            loading: false,
          }));
          setMnsState({
            isResolving: false,
            resolvedGossipId: null,
            resolvedDomain: null,
          });
          return;
        }

        // Store the resolved gossip ID and continue with public key fetching
        setMnsState({
          isResolving: false,
          resolvedGossipId,
          resolvedDomain: trimmed,
        });

        await fetchAndValidateId(resolvedGossipId, seq);
        return;
      }

      // Not an MNS domain - handle as regular gossip ID
      // Prevent adding own user ID as a contact
      if (userProfile?.userId && trimmed === userProfile.userId) {
        setUserId(_ => ({
          value: trimmed,
          error: 'You cannot add yourself as a contact',
          loading: false,
        }));
        return;
      }

      setUserId(prev => ({
        ...prev,
        error: undefined,
        loading: true,
      }));

      const result = validateUserIdFormat(trimmed);

      if (!result.valid) {
        setUserId(_ => ({
          value: trimmed,
          error: mnsEnabled
            ? 'Invalid format — must be a valid user ID or MNS (name.massa)'
            : 'Invalid format — must be a valid user ID',
          loading: false,
        }));
        return;
      }

      await fetchAndValidateId(trimmed, seq);
    },
    [fetchAndValidateId, userProfile?.userId, mnsEnabled]
  );

  return {
    userId,
    setUserId,
    publicKeys,
    setPublicKeys,
    mnsState,
    handleUserIdChange,
    cachePublicKey,
  };
}
