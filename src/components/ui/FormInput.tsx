import React from 'react';

interface FormInputProps {
  id: string;
  label?: string | React.ReactNode;
  value: string;
  onChange: (value: string) => void;
  onBlur?: (value: string) => void;
  placeholder?: string;
  error?: string | null;
  helperText?: string;
  type?: 'text' | 'textarea';
  textareaRows?: number;
  maxLength?: number;
  showCharCount?: boolean;
  isLoading?: boolean;
  loadingLabel?: string;
  rightElement?: React.ReactNode;
  className?: string;
}

const FormInput: React.FC<FormInputProps> = ({
  id,
  label,
  value,
  onChange,
  onBlur,
  placeholder,
  error,
  helperText,
  type = 'text',
  textareaRows = 3,
  maxLength,
  showCharCount = false,
  isLoading = false,
  loadingLabel,
  rightElement,
  className = '',
}) => {
  // Only show success styling when there's no error and the trimmed value has content
  const hasValidContent = !error && value.trim().length > 0;

  const labelClassName = `block text-sm font-medium mb-2 ${
    error
      ? 'text-destructive'
      : hasValidContent
        ? 'text-success'
        : 'text-foreground'
  }`;

  const inputClassName = `w-full px-4 py-3.5 rounded-xl border bg-input text-foreground placeholder-muted-foreground focus:ring-2 focus:border-transparent ${
    error
      ? 'border-destructive focus:ring-destructive'
      : hasValidContent
        ? 'border-success focus:ring-success'
        : 'border-border focus:ring-primary'
  } ${className}`;

  return (
    <div>
      <label htmlFor={id} className={labelClassName}>
        {label}
      </label>
      <div className="relative">
        {type === 'textarea' ? (
          <textarea
            id={id}
            value={value}
            onChange={e => onChange(e.target.value)}
            onBlur={onBlur ? e => onBlur(e.target.value) : undefined}
            placeholder={placeholder}
            rows={textareaRows}
            maxLength={maxLength}
            className={`${inputClassName} resize-none`}
          />
        ) : (
          <input
            id={id}
            type="text"
            value={value}
            onChange={e => onChange(e.target.value)}
            onBlur={onBlur ? e => onBlur(e.target.value) : undefined}
            placeholder={placeholder}
            maxLength={maxLength}
            aria-invalid={!!error}
            aria-describedby={
              error ? `${id}-error` : helperText ? `${id}-helper` : undefined
            }
            className={inputClassName}
          />
        )}
        {isLoading && (
          <div className="absolute right-4 top-1/2 -translate-y-1/2">
            <div
              className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin"
              aria-label={loadingLabel || 'Loading'}
            />
          </div>
        )}
        {rightElement && !isLoading && (
          <div className="absolute right-4 top-1/2 -translate-y-1/2">
            {rightElement}
          </div>
        )}
      </div>
      {error && (
        <p
          id={`${id}-error`}
          className="mt-1.5 text-sm text-destructive"
          role="alert"
        >
          {error}
        </p>
      )}
      {helperText && !error && (
        <p className="mt-2 text-xs text-muted-foreground">{helperText}</p>
      )}
      {showCharCount && maxLength && (
        <p className="mt-2 text-right text-xs text-muted-foreground">
          {value.length}/{maxLength}
        </p>
      )}
    </div>
  );
};

export default FormInput;
