import React from 'react';

interface RoundedInputProps {
  type?: 'text' | 'password' | 'email';
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  placeholder?: string;
  error?: boolean;
  disabled?: boolean;
  maxLength?: number;
  className?: string;
}

const RoundedInput: React.FC<RoundedInputProps> = ({
  type = 'text',
  value,
  onChange,
  onKeyDown,
  placeholder,
  error = false,
  disabled = false,
  maxLength,
  className = '',
}) => {
  return (
    <input
      type={type}
      value={value}
      onChange={onChange}
      onKeyDown={onKeyDown}
      placeholder={placeholder}
      maxLength={maxLength}
      disabled={disabled}
      className={`w-full h-12 px-4 rounded-full border text-sm focus:outline-none focus:ring-2 transition text-foreground dark:text-foreground bg-card dark:bg-input placeholder-muted-foreground dark:placeholder-muted-foreground ${
        error
          ? 'border-destructive/60 focus:ring-destructive/30 dark:border-destructive/70 dark:focus:ring-destructive/40'
          : 'border-border focus:ring-ring/30 dark:border-border dark:focus:ring-ring/40'
      } ${className}`}
    />
  );
};

export default RoundedInput;
