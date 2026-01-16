import { useCallback, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Contact, db as appDb } from '../db';
import { useAccountStore } from '../stores/accountStore';
import { useAppStore } from '../stores/appStore';
import {
  validateUserIdFormat,
  validateUsernameFormat,
  encodeUserId,
  UserPublicKeys,
  type PublicKeyResult,
} from 'gossip-sdk';
import { authService, discussionService } from '../services';
import { useFileShareContact } from './useFileShareContact';
import { mnsService, isMnsDomain } from '../services/mns';
import toast from 'react-hot-toast';
import { ROUTES } from '../constants/routes';

type FieldState = {
  value: string;
  error?: string;
  loading: boolean;
};

type MnsState = {
  /** Whether an MNS domain resolution is in progress */
  isResolving: boolean;
  /** The resolved gossip ID (if successful) */
  resolvedGossipId: string | null;
  /** The original MNS domain that was resolved */
  resolvedDomain: string | null;
};

export function useContactForm() {
  const navigate = useNavigate();
  const { userProfile, session } = useAccountStore();
  const mnsEnabled = useAppStore(s => s.mnsEnabled);
  const { importFileContact, fileState } = useFileShareContact();

  const publicKeysCache = useRef<Map<string, UserPublicKeys>>(new Map());

  const [name, setName] = useState<FieldState>({
    value: '',
    loading: false,
  });
  const [userId, setUserId] = useState<FieldState>({
    value: '',
    loading: false,
  });
  const [message, setMessage] = useState<FieldState>({
    value: '',
    loading: false,
  });

  const [publicKeys, setPublicKeys] = useState<UserPublicKeys | null>(null);

  const [mnsState, setMnsState] = useState<MnsState>({
    isResolving: false,
    resolvedGossipId: null,
    resolvedDomain: null,
  });

  const [generalError, setGeneralError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const getPublicKey = useCallback(
    async (uid: string): Promise<PublicKeyResult> => {
      const cached = publicKeysCache.current.get(uid);

      if (cached) {
        return { publicKey: cached };
      }

      const result = await authService.fetchPublicKeyByUserId(uid);

      if (result.publicKey) {
        publicKeysCache.current.set(uid, result.publicKey);
      }

      return result;
    },
    []
  );

  const canSubmit =
    !name.error &&
    name.value.trim().length > 0 &&
    !userId.error &&
    userId.value.trim().length > 0 &&
    publicKeys !== null &&
    !isSubmitting &&
    !userId.loading;

  const hasUnsavedChanges =
    !!name.value.trim() || !!userId.value.trim() || !!message.value.trim();

  // ──────────────────────────────────────────────────────────────
  // Handlers
  // ──────────────────────────────────────────────────────────────
  const handleNameChange = useCallback((value: string) => {
    const trimmed = value.trim();
    const result = validateUsernameFormat(trimmed);
    setName(_ => ({
      value: trimmed,
      error: result.error,
      loading: false,
    }));
  }, []);

  const handleUserIdChange = useCallback(
    async (value: string) => {
      const trimmed = value.trim();

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

        // Fetch public key for the resolved gossip ID
        const { publicKey, error } = await getPublicKey(resolvedGossipId);

        if (!publicKey) {
          setUserId(prev => ({ ...prev, error, loading: false }));
          return;
        }

        setPublicKeys(publicKey);
        setUserId(prev => ({ ...prev, loading: false }));
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

      const { publicKey, error } = await getPublicKey(trimmed);

      if (!publicKey) {
        setUserId(prev => ({ ...prev, error, loading: false }));
        return;
      }

      setPublicKeys(publicKey);
      setUserId(prev => ({ ...prev, loading: false }));
    },
    [getPublicKey, userProfile?.userId, mnsEnabled]
  );

  const handleMessageChange = useCallback((value: string) => {
    setMessage({ value, loading: false });
  }, []);

  const handleFileImport = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      if (!userProfile?.userId) return;
      const file = event.target.files?.[0];
      if (!file) return;

      const fileContact = await importFileContact(file);
      if (!fileContact) return;

      const pubKeys = UserPublicKeys.from_bytes(fileContact.userPubKeys);
      const derivedUserId = encodeUserId(pubKeys.derive_id());

      // Prevent importing our own user ID as a contact
      if (derivedUserId === userProfile.userId) {
        toast.error('You cannot add yourself as a contact');
        return;
      }

      // check here if user already exists in contacts
      const contact = await appDb.getContactByOwnerAndUserId(
        userProfile.userId,
        derivedUserId
      );

      if (contact) {
        toast.error('User already registred');
        return;
      }

      setPublicKeys(pubKeys);
      publicKeysCache.current.set(derivedUserId, pubKeys);

      if (fileContact.userName) {
        handleNameChange(fileContact.userName);
      }

      setUserId({ value: derivedUserId, loading: false });
    },
    [importFileContact, handleNameChange, userProfile]
  );

  const handleSubmit = useCallback(async () => {
    const trimmedName = name.value.trim();
    const trimmedUserId = userId.value.trim();

    // Use resolved gossip ID if MNS resolution was successful, otherwise use the input
    const effectiveUserId = mnsState.resolvedGossipId || trimmedUserId;

    // Surface missing or pending requirements as field errors when user tries to submit
    if (!trimmedName) {
      setName(prev => ({
        ...prev,
        error: prev.error || 'Display name is required',
      }));
    }

    if (!trimmedUserId) {
      setUserId(prev => ({
        ...prev,
        error: prev.error || 'User ID is required',
      }));
    }

    if (userId.loading) {
      setUserId(prev => ({
        ...prev,
        error: prev.error || 'Resolving user ID, please wait…',
      }));
    }

    if (!publicKeys && trimmedUserId) {
      setUserId(prev => ({
        ...prev,
        error:
          prev.error ||
          'Unable to load public key for this user ID. Please check it.',
      }));
    }

    // Prevent adding own user ID as a contact, even if previous checks passed
    if (userProfile?.userId && effectiveUserId === userProfile.userId) {
      setUserId(prev => ({
        ...prev,
        error: 'You cannot add yourself as a contact',
      }));
      return;
    }

    if (!canSubmit || !userProfile?.userId || !publicKeys || !session) {
      return;
    }

    setIsSubmitting(true);
    setGeneralError(null);

    try {
      // Duplicate checks
      const contacts = await appDb.getContactsByOwner(userProfile.userId);
      const nameTaken = contacts.some(
        c => c.name.toLowerCase() === trimmedName.toLowerCase()
      );
      if (nameTaken) {
        setName(prev => ({
          ...prev,
          error: 'This display name is already in use',
        }));
        setIsSubmitting(false);
        return;
      }

      const existing = await appDb.getContactByOwnerAndUserId(
        userProfile.userId,
        effectiveUserId
      );
      if (existing) {
        setUserId(prev => ({
          ...prev,
          error: 'This user is already in your contacts',
        }));
        setIsSubmitting(false);
        return;
      }

      const contact: Omit<Contact, 'id'> = {
        ownerUserId: userProfile.userId,
        name: trimmedName,
        userId: effectiveUserId,
        publicKeys: publicKeys.to_bytes(),
        avatar: undefined,
        isOnline: false,
        lastSeen: new Date(),
        createdAt: new Date(),
      };

      await appDb.contacts.add(contact);

      const announcementMessage = message.value.trim() || undefined;
      try {
        await discussionService.initialize(
          contact,
          session,
          announcementMessage
        );
      } catch (e) {
        console.error(
          'Failed to initialize discussion after contact creation:',
          e
        );
      }

      navigate(ROUTES.default());
    } catch (err) {
      console.error(err);
      setGeneralError('Failed to add contact. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  }, [
    canSubmit,
    userProfile?.userId,
    publicKeys,
    name.value,
    userId.value,
    message.value,
    userId.loading,
    mnsState.resolvedGossipId,
    navigate,
    session,
  ]);

  return {
    name,
    userId,
    message,
    mnsState,

    generalError,
    isSubmitting,
    fileState,

    canSubmit,
    hasUnsavedChanges,

    handleNameChange,
    handleUserIdChange,
    handleMessageChange,
    handleFileImport,
    handleSubmit,
  };
}
