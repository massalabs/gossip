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
      className={`w-full h-12 px-4 rounded-full border text-sm focus:outline-none focus:ring-2 transition text-gray-900 dark:text-white bg-white dark:bg-gray-800 placeholder-gray-400 dark:placeholder-gray-500 ${
        error
          ? 'border-red-300 dark:border-red-600 focus:ring-red-200 dark:focus:ring-red-900/40'
          : 'border-gray-200 dark:border-gray-700 focus:ring-blue-200 dark:focus:ring-blue-900/40'
      } ${className}`}
    />
  );
};

export default RoundedInput;
