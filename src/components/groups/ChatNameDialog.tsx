import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import BaseModal from '../ui/BaseModal';
import Button from '../ui/Button';
import { utf8Bytes } from '../../utils/textBytes';

interface ChatNameDialogProps {
  isOpen: boolean;
  /** The name the field starts with: the user's own name, else the shared one. */
  initialName: string;
  /** The user has their own name for the chat on this device. */
  hasOwnName: boolean;
  /** The owner of an active chat: "Save for everyone" is offered. */
  canSaveForEveryone: boolean;
  /** The largest name, in UTF-8 bytes. */
  maxBytes: number;
  onSaveForMe: (name: string | null) => void;
  onSaveForEveryone: (name: string) => void;
  onClose: () => void;
}

/**
 * The one place that changes the chat's name (UI1): the name in a field, and
 * the buttons that apply. "Save for me" keeps it on this device only; with an
 * empty field it removes the user's own name, and the shared name shows again,
 * which its label then says. "Save for everyone" is the owner's rename.
 */
const ChatNameDialog: React.FC<ChatNameDialogProps> = ({
  isOpen,
  initialName,
  hasOwnName,
  canSaveForEveryone,
  maxBytes,
  onSaveForMe,
  onSaveForEveryone,
  onClose,
}) => {
  const { t } = useTranslation('groups');
  const [name, setName] = useState(initialName);
  useEffect(() => {
    if (isOpen) setName(initialName);
  }, [isOpen, initialName]);

  const trimmed = name.trim();
  const tooLong = utf8Bytes(trimmed) > maxBytes;
  // An empty field with "Save for me" goes back to the shared name.
  const clearsOwn = trimmed === '' && hasOwnName;

  return (
    <BaseModal
      isOpen={isOpen}
      onClose={onClose}
      title={t('details.name_title')}
    >
      <div className="space-y-4" data-testid="chat-name-dialog">
        <div>
          <label
            htmlFor="chat-name"
            className="block text-sm font-medium text-foreground mb-1"
          >
            {t('details.name_label')}
          </label>
          <input
            id="chat-name"
            type="text"
            autoFocus
            value={name}
            onChange={e => setName(e.target.value)}
            className="w-full h-11 px-3 rounded-lg border border-border bg-card dark:bg-input text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            enterKeyHint="done"
            aria-invalid={tooLong || undefined}
          />
          {tooLong && (
            <p className="mt-1 text-xs text-destructive" role="alert">
              {t('new_group.name_too_long')}
            </p>
          )}
          <p className="mt-2 text-xs text-muted-foreground">
            {canSaveForEveryone
              ? t('details.name_hint_owner')
              : t('details.name_hint_member')}
          </p>
        </div>
        <div className="flex flex-col gap-2">
          {canSaveForEveryone && (
            <Button
              variant="primary"
              size="custom"
              className="w-full h-11 rounded-lg font-semibold"
              disabled={tooLong}
              onClick={() => onSaveForEveryone(trimmed)}
            >
              {t('details.save_for_everyone')}
            </Button>
          )}
          <Button
            variant={canSaveForEveryone ? 'secondary' : 'primary'}
            size="custom"
            className="w-full h-11 rounded-lg font-semibold"
            disabled={tooLong}
            onClick={() => onSaveForMe(trimmed === '' ? null : trimmed)}
          >
            {clearsOwn
              ? t('details.use_shared_name')
              : t('details.save_for_me')}
          </Button>
          <Button
            variant="ghost"
            size="custom"
            className="w-full h-11 rounded-lg font-semibold"
            onClick={onClose}
          >
            {t('choices.cancel')}
          </Button>
        </div>
      </div>
    </BaseModal>
  );
};

export default ChatNameDialog;
