import React from 'react';

interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
}

const Toggle: React.FC<ToggleProps> = ({
  checked,
  onChange,
  disabled = false,
  className = '',
  ariaLabel,
}) => {
  const baseClasses =
    'relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50';

  const checkedClasses = checked
    ? 'bg-primary'
    : 'bg-gray-300 dark:bg-gray-600';

  const combinedClasses =
    `${baseClasses} ${checkedClasses} ${className}`.trim();

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={combinedClasses}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
          checked ? 'translate-x-6' : 'translate-x-1'
        }`}
      />
    </button>
  );
};

export default Toggle;
