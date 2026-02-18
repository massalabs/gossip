import React, { useState } from 'react';
import { Eye, EyeOff } from 'react-feather';

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
  const [showPassword, setShowPassword] = useState(false);
  const isPassword = type === 'password';
  const inputType = isPassword && showPassword ? 'text' : type;

  return (
    <div className="relative">
      <input
        type={inputType}
        value={value}
        onChange={onChange}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        maxLength={maxLength}
        disabled={disabled}
        className={`w-full h-12 px-4 ${isPassword ? 'pr-12' : ''} rounded-full border text-sm focus:outline-none focus:ring-2 transition text-foreground dark:text-foreground bg-card dark:bg-input placeholder-muted-foreground dark:placeholder-muted-foreground ${
          error
            ? 'border-destructive/60 focus:ring-destructive/30 dark:border-destructive/70 dark:focus:ring-destructive/40'
            : 'border-border focus:ring-ring/30 dark:border-border dark:focus:ring-ring/40'
        } ${className}`}
      />
      {isPassword && (
        <button
          type="button"
          onPointerDown={e => {
            e.preventDefault();
            setShowPassword(prev => !prev);
          }}
          tabIndex={-1}
          className="absolute right-4 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors touch-manipulation p-1"
        >
          {showPassword ? (
            <EyeOff className="w-4 h-4" />
          ) : (
            <Eye className="w-4 h-4" />
          )}
        </button>
      )}
    </div>
  );
};

export default RoundedInput;
