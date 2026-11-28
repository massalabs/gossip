import { logger } from '../utils/logger.ts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Contact } from '@massalabs/gossip-sdk';
import { useAccountStore } from '../stores/accountStore';
import {
  encodeUserId,
  UserPublicKeys,
  AnnouncementPayload,
} from '@massalabs/gossip-sdk';
import { validateUsernameFormat } from '../utils/validation';
import { useGossipSdk } from './useGossipSdk';
import { useFileShareContact } from './useFileShareContact';
import { useUserIdResolution, FieldState } from './useUserIdResolution';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { ROUTES } from '../constants/routes';
import {
  isConnectedNonContact,
  isDisplayNameTaken,
} from '../utils/conversations';

export function useContactForm() {
  const { t } = useTranslation('contacts');
  const gossip = useGossipSdk();
  const navigate = useNavigate();
  const userProfile = useAccountStore(s => s.userProfile);
  const { importFileContact, fileState } = useFileShareContact();

  const {
    userId,
    setUserId,
    publicKeys,
    setPublicKeys,
    connectedNonContact,
    setConnectedNonContact,
    mnsState,
    handleUserIdChange,
    cachePublicKey,
  } = useUserIdResolution();

  const [name, setName] = useState<FieldState>({
    value: '',
    loading: false,
  });
  const [message, setMessage] = useState<FieldState>({
    value: '',
    loading: false,
  });

  const [shareUsername, setShareUsername] = useState(true);
  const [customUsername, setCustomUsername] = useState(
    userProfile?.username || ''
  );
  const [customUsernameError, setCustomUsernameError] = useState<
    string | undefined
  >(undefined);

  // Seed customUsername from the profile username once, when it first
  // becomes available — never repopulate after the user edits/clears it
  const customUsernameSeededRef = useRef(!!userProfile?.username);
  useEffect(() => {
    if (userProfile?.username && !customUsernameSeededRef.current) {
      customUsernameSeededRef.current = true;
      setCustomUsername(userProfile.username);
    }
  }, [userProfile?.username]);

  const [generalError, setGeneralError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const canSubmit =
    !name.error &&
    name.value.trim().length > 0 &&
    !userId.error &&
    userId.value.trim().length > 0 &&
    // Nothing is sent to a member of a shared chat: no username to check.
    (connectedNonContact || !shareUsername || !customUsernameError) &&
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

  const handleMessageChange = useCallback((value: string) => {
    setMessage({ value, loading: false });
  }, []);

  const handleShareUsernameChange = useCallback((value: boolean) => {
    setShareUsername(value);
  }, []);

  const handleCustomUsernameChange = useCallback((value: string) => {
    customUsernameSeededRef.current = true;
    setCustomUsername(value);
    setCustomUsernameError(undefined);
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

      // A contact already, unless a member of a shared chat who is no
      // contact: adding them is local (§5.12).
      const contact = await gossip.contacts.get(derivedUserId);

      if (contact && !isConnectedNonContact(contact)) {
        toast.error(t('new_contact.already_contact'));
        return;
      }

      setPublicKeys(pubKeys);
      setConnectedNonContact(!!contact);
      cachePublicKey(derivedUserId, pubKeys);

      if (fileContact.userName) {
        handleNameChange(fileContact.userName);
      }

      setUserId({ value: derivedUserId, loading: false });
    },
    [
      userProfile?.userId,
      importFileContact,
      gossip.contacts,
      handleNameChange,
      setPublicKeys,
      setConnectedNonContact,
      cachePublicKey,
      setUserId,
      t,
    ]
  );

  /**
   * A contact read in person (contact code): its keys were already checked
   * against the user id, so no server lookup is needed.
   */
  const handleVerifiedContact = useCallback(
    (contactUserId: string, keys: UserPublicKeys, contactName?: string) => {
      cachePublicKey(contactUserId, keys);
      void handleUserIdChange(contactUserId);
      if (contactName) handleNameChange(contactName);
    },
    [cachePublicKey, handleUserIdChange, handleNameChange]
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

    if (shareUsername && !connectedNonContact) {
      const customUsernameResult = validateUsernameFormat(
        customUsername.trim()
      );
      if (!customUsernameResult.valid) {
        setCustomUsernameError(customUsernameResult.error);
        return;
      }
      setCustomUsernameError(undefined);
    }

    // Prevent adding own user ID as a contact, even if previous checks passed
    if (userProfile?.userId && effectiveUserId === userProfile.userId) {
      setUserId(prev => ({
        ...prev,
        error: 'You cannot add yourself as a contact',
      }));
      return;
    }

    if (
      !canSubmit ||
      !userProfile?.userId ||
      !publicKeys ||
      !gossip.isSessionOpen
    ) {
      return;
    }

    setIsSubmitting(true);
    setGeneralError(null);

    try {
      // Duplicate checks
      const contacts = await gossip.contacts.list();
      if (isDisplayNameTaken(contacts, trimmedName, effectiveUserId)) {
        setName(prev => ({
          ...prev,
          error: 'This display name is already in use',
        }));
        setIsSubmitting(false);
        return;
      }

      const existing = await gossip.contacts.get(effectiveUserId);
      if (isConnectedNonContact(existing)) {
        // A member of a shared chat (§5.12): made a contact on this device
        // only. No request is sent, so no message or username: the session
        // exists already, and no message tells anyone who added whom.
        const added = await gossip.conversations.addAsContact(
          effectiveUserId,
          trimmedName
        );
        if (!added.success) {
          setGeneralError('Failed to add contact. Please try again.');
          return;
        }
        navigate(ROUTES.default());
        return;
      }
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

      const result = await gossip.contacts.add(
        effectiveUserId,
        trimmedName,
        publicKeys
      );
      if (!result.success && result.error) {
        logger.error('Failed to add contact:', result.error);
        setGeneralError('Failed to add contact. Please try again.');
        return;
      }

      const payload: AnnouncementPayload = {
        username: shareUsername ? customUsername.trim() : undefined,
        message: message.value.trim(),
      };

      try {
        // A contact request starts no chat (§5.12): either person starts
        // one later from the contact's screen, with its message timer.
        await gossip.discussions.start(contact, payload);
      } catch (e) {
        logger.error(
          'Failed to initialize discussion after contact creation:',
          e
        );
      }

      navigate(ROUTES.default());
    } catch (err) {
      logger.error(err);
      setGeneralError('Failed to add contact. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  }, [
    name.value,
    userId.value,
    userId.loading,
    mnsState.resolvedGossipId,
    publicKeys,
    userProfile?.userId,
    canSubmit,
    shareUsername,
    customUsername,
    message.value,
    connectedNonContact,
    gossip,
    navigate,
    setUserId,
  ]);

  return {
    name,
    userId,
    message,
    mnsState,
    shareUsername,
    customUsername,
    customUsernameError,
    connectedNonContact,

    generalError,
    isSubmitting,
    fileState,

    canSubmit,
    hasUnsavedChanges,

    handleNameChange,
    handleUserIdChange,
    handleMessageChange,
    handleShareUsernameChange,
    handleCustomUsernameChange,
    handleFileImport,
    handleVerifiedContact,
    handleSubmit,
  };
}
