import React, { useEffect, useState, useCallback, useRef } from 'react';
import BaseModal from '../ui/BaseModal';
import Button from '../ui/Button';
import { useKeyDown } from '../../hooks/useKeyDown';
import { validateUsernameFormat } from 'gossip-sdk';
import { db } from 'gossip-sdk';

interface UsernameEditModalProps {
  isOpen: boolean;
  currentUsername: string;
  currentUserId: string;
  onConfirm: (username: string) => Promise<void>;
  onClose: () => void;
}

const UsernameEditModal: React.FC<UsernameEditModalProps> = ({
  isOpen,
  currentUsername,
  currentUserId,
  onConfirm,
  onClose,
}) => {
  const [username, setUsername] = useState(currentUsername);
  const [error, setError] = useState<string | null>(null);
  const [isValidating, setIsValidating] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { onEnter } = useKeyDown({ enabled: isOpen });

  // Use refs to store stable values that don't need to trigger re-renders
  const currentUsernameRef = useRef(currentUsername);
  const currentUserIdRef = useRef(currentUserId);
  const onConfirmRef = useRef(onConfirm);
  const onCloseRef = useRef(onClose);
  const validateTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentInputValueRef = useRef<string>('');
  const handleConfirmRef = useRef<() => Promise<void>>(() => Promise.resolve());

  // Update refs when props change (without causing re-renders)
  useEffect(() => {
    currentUsernameRef.current = currentUsername;
    currentUserIdRef.current = currentUserId;
    onConfirmRef.current = onConfirm;
    onCloseRef.current = onClose;
  }, [currentUsername, currentUserId, onConfirm, onClose]);

  // Only reset state when modal opens, not when currentUsername changes
  useEffect(() => {
    if (isOpen) {
      const initialUsername = currentUsernameRef.current;
      setUsername(initialUsername);
      currentInputValueRef.current = initialUsername;
      setError(null);
      setIsValidating(false);
      setIsSubmitting(false);
    }
  }, [isOpen]);

  const validateUsername = useCallback(
    async (value: string): Promise<boolean> => {
      const trimmed = value.trim();
      const currentUsername = currentUsernameRef.current;
      const currentUserId = currentUserIdRef.current;

      // If username hasn't changed, it's valid
      if (trimmed === currentUsername) {
        setError(null);
        setIsValidating(false);
        return true;
      }

      // If empty or too short, don't validate (handled in handleUsernameChange)
      if (trimmed.length < 3) {
        setError(null);
        setIsValidating(false);
        return false;
      }

      // Validate format
      const formatResult = validateUsernameFormat(trimmed);
      if (!formatResult.valid) {
        setError(formatResult.error);
        setIsValidating(false);
        return false;
      }

      // Validate availability (excluding current user)
      setIsValidating(true);
      try {
        if (!db.isOpen()) {
          await db.open();
        }

        const existingProfile = await db.userProfile
          .filter(
            profile =>
              profile.username.trim().toLowerCase() === trimmed.toLowerCase() &&
              profile.userId !== currentUserId
          )
          .first();

        if (existingProfile) {
          setError('This username is already in use. Please choose another.');
          setIsValidating(false);
          return false;
        }

        setError(null);
        setIsValidating(false);
        return true;
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : 'Unable to verify username availability. Please try again.'
        );
        setIsValidating(false);
        return false;
      }
    },
    []
  );

  const handleUsernameChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value;
      setUsername(value);
      currentInputValueRef.current = value; // Track current input value

      // Clear existing timeout
      if (validateTimeoutRef.current) {
        clearTimeout(validateTimeoutRef.current);
        validateTimeoutRef.current = null;
      }

      const trimmed = value.trim();

      // If empty or same as current username, clear error immediately
      if (trimmed === '' || trimmed === currentUsernameRef.current) {
        setError(null);
        setIsValidating(false);
        return;
      }

      // Don't show format errors until user has typed at least 3 characters
      // This prevents brief error flashes when user is still typing
      if (trimmed.length < 3) {
        setError(null);
        setIsValidating(false);
        // Don't set up validation timeout for short values
        return;
      }

      // Clear error while user is typing (will be set by validation if needed)
      setError(null);
      setIsValidating(false);

      // Debounce validation - only run if value is at least 3 characters
      validateTimeoutRef.current = setTimeout(async () => {
        // Get the current value from ref (most up-to-date)
        const currentValue = currentInputValueRef.current.trim();

        // Only validate if still at least 3 characters and different from current username
        if (
          currentValue.length >= 3 &&
          currentValue !== currentUsernameRef.current
        ) {
          await validateUsername(currentInputValueRef.current);
        } else {
          // If value became invalid during debounce, clear error
          setError(null);
          setIsValidating(false);
        }
      }, 500);
    },
    [validateUsername]
  );

  useEffect(() => {
    return () => {
      if (validateTimeoutRef.current) {
        clearTimeout(validateTimeoutRef.current);
      }
    };
  }, []);

  const handleConfirm = useCallback(async () => {
    const trimmed = username.trim();
    const currentUsername = currentUsernameRef.current;

    if (trimmed === currentUsername) {
      // No change, just close
      onCloseRef.current();
      return;
    }

    // Validate before submitting
    const isValid = await validateUsername(trimmed);
    if (!isValid) {
      return;
    }

    setIsSubmitting(true);
    try {
      await onConfirmRef.current(trimmed);
      onCloseRef.current();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Failed to update username. Please try again.'
      );
    } finally {
      setIsSubmitting(false);
    }
  }, [username, validateUsername]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      // Don't submit while composing (IME)
      if (e.nativeEvent.isComposing) return;

      // Handle Enter key to submit
      if (
        e.key === 'Enter' &&
        !e.shiftKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.metaKey
      ) {
        e.preventDefault();
        if (!isSubmitting && !isValidating && username.trim() !== '') {
          handleConfirm();
        }
      }
    },
    [handleConfirm, isSubmitting, isValidating, username]
  );

  // Set up Enter key handler - use ref to avoid re-creating on every render
  useEffect(() => {
    handleConfirmRef.current = handleConfirm;
  }, [handleConfirm]);

  useEffect(() => {
    if (!isOpen) return;

    const enterHandler = () => {
      handleConfirmRef.current();
    };

    onEnter(enterHandler);
  }, [isOpen, onEnter]);

  return (
    <BaseModal isOpen={isOpen} onClose={onClose} title="Edit Username">
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-foreground mb-1">
            Username
          </label>
          <input
            type="text"
            autoFocus
            value={username}
            onChange={handleUsernameChange}
            onKeyDown={handleKeyDown}
            disabled={isSubmitting}
            className="w-full h-11 px-3 rounded-lg border border-border bg-card dark:bg-input text-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50 disabled:cursor-not-allowed"
            placeholder="Enter username"
            enterKeyHint="done"
          />
          {error && (
            <p className="mt-1 text-xs text-destructive" role="alert">
              {error}
            </p>
          )}
          {isValidating && !error && (
            <p className="mt-1 text-xs text-muted-foreground">
              Checking availability...
            </p>
          )}
        </div>
        <div className="flex gap-3">
          <Button
            onClick={handleConfirm}
            variant="primary"
            size="custom"
            className="flex-1 h-11 rounded-xl text-sm font-medium"
            disabled={isSubmitting || isValidating || username.trim() === ''}
          >
            {isSubmitting ? 'Saving...' : 'Save'}
          </Button>
          <Button
            onClick={onClose}
            variant="secondary"
            size="custom"
            className="flex-1 h-11 rounded-lg font-semibold"
            disabled={isSubmitting}
          >
            Cancel
          </Button>
        </div>
      </div>
    </BaseModal>
  );
};

export default UsernameEditModal;
