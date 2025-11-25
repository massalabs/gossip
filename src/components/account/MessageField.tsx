import React from 'react';
import FormInput from '../ui/FormInput';
import { useAccountStore } from '../../stores/accountStore';

interface MessageFieldProps {
  message: string;
  onChange: (value: string) => void;
}

const MessageField: React.FC<MessageFieldProps> = ({ message, onChange }) => {
  const { userProfile } = useAccountStore();
  const myUsername = userProfile?.username;

  const getDefaultMessage = (): string => {
    if (myUsername) {
      return `Hi! I'm ${myUsername} and I'd like to connect with you.`;
    }
    return "Hi! I'd like to connect with you.";
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
        Contact request message{' '}
        <span className="text-muted-foreground font-normal">(optional)</span>
      </label>
      <FormInput
        id="contact-message"
        value={message}
        onChange={onChange}
        placeholder="Introduce yourself or add context to your contact request..."
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
            Use default message
          </button>
        </div>
      )}
    </div>
  );
};

export default MessageField;
