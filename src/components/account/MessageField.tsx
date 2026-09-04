import React from 'react';
import { useTranslation } from 'react-i18next';
import FormInput from '../ui/FormInput';
import { useAccountStore } from '../../stores/accountStore';

interface MessageFieldProps {
  message: string;
  onChange: (value: string) => void;
}

const MessageField: React.FC<MessageFieldProps> = ({ message, onChange }) => {
  const { t } = useTranslation('contacts');
  const { userProfile } = useAccountStore();
  const myUsername = userProfile?.username;

  const getDefaultMessage = (): string => {
    if (myUsername) {
      return t('new_contact.default_message', { username: myUsername });
    }
    return t('new_contact.default_message_anonymous');
  };

  const handleFillDefault = (e: React.MouseEvent) => {
    e.preventDefault();
    onChange(getDefaultMessage());
  };

  return (
    <div className="space-y-2">
      <label
        htmlFor="contact-message"
        className="block text-sm font-medium text-foreground"
      >
        {t('message_label_main')}{' '}
        <span className="text-muted-foreground font-normal">
          {t('message_label_optional')}
        </span>
      </label>
      <FormInput
        id="contact-message"
        value={message}
        onChange={onChange}
        placeholder={t('message_placeholder')}
        type="textarea"
        textareaRows={3}
        maxLength={500}
        showCharCount={!!message}
      />
      {!message && (
        <div className="flex items-center justify-between text-xs mt-2">
          <button
            type="button"
            onClick={handleFillDefault}
            className="text-muted-foreground hover:text-primary underline underline-offset-2 active:text-primary/80 transition-colors"
          >
            {t('use_default_message')}
          </button>
        </div>
      )}
    </div>
  );
};

export default MessageField;
