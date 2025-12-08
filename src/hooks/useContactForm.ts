import { useCallback, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Contact, db } from '../db';
import { useAccountStore } from '../stores/accountStore';
import {
  encodeUserId,
  validateUsernameFormat,
  validateUserIdFormat,
} from '../utils';
import { UserPublicKeys } from '../assets/generated/wasm/gossip_wasm';
import { ensureDiscussionExists } from '../crypto/discussionInit';
import { useFileShareContact } from './useFileShareContact';
import { authService, PublicKeyResult } from '../services/auth';
import toast from 'react-hot-toast';
import { ROUTES } from '../constants/routes';

type FieldState = {
  value: string;
  error?: string;
  loading: boolean;
};

export function useContactForm() {
  const navigate = useNavigate();
  const { userProfile } = useAccountStore();
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

      if (!trimmed) return;

      setUserId(prev => ({
        ...prev,
        error: undefined,
        loading: true,
      }));

      const result = validateUserIdFormat(trimmed);

      if (!result.valid) {
        setUserId(_ => ({
          value: trimmed,
          error: result.error,
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
    [getPublicKey]
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

      // check here if user already exists in contacts
      const contact = await db.getContactByOwnerAndUserId(
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
    if (!canSubmit || !userProfile?.userId || !publicKeys) return;

    setIsSubmitting(true);
    setGeneralError(null);

    try {
      const trimmedName = name.value.trim();
      const trimmedUserId = userId.value.trim();

      // Duplicate checks
      const contacts = await db.getContactsByOwner(userProfile.userId);
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

      const existing = await db.getContactByOwnerAndUserId(
        userProfile.userId,
        trimmedUserId
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
        userId: trimmedUserId,
        publicKeys: publicKeys.to_bytes(),
        avatar: undefined,
        isOnline: false,
        lastSeen: new Date(),
        createdAt: new Date(),
      };

      await db.contacts.add(contact);

      const announcement = message.value.trim() || undefined;
      await ensureDiscussionExists(contact, undefined, announcement).catch(
        console.error
      );

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
    navigate,
  ]);

  return {
    name,
    userId,
    message,

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
