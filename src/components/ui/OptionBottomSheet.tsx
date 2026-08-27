import React from 'react';

export interface BottomSheetOption {
  label: string;
  value: number | null;
}

interface OptionBottomSheetProps {
  isOpen: boolean;
  title: string;
  description?: string;
  options: BottomSheetOption[];
  selectedValue: number | null;
  onSelect: (value: number | null) => void;
  onClose: () => void;
}

/**
 * Bottom-sheet single-choice picker shared by the retention and auto-lock
 * settings (previously copy-pasted on four pages).
 */
const OptionBottomSheet: React.FC<OptionBottomSheetProps> = ({
  isOpen,
  title,
  description,
  options,
  selectedValue,
  onSelect,
  onClose,
}) => {
  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="bg-background w-full max-w-md rounded-t-2xl p-6 pb-8"
        onClick={e => e.stopPropagation()}
      >
        <h3
          className={`text-base font-semibold text-foreground ${
            description ? 'mb-1' : 'mb-4'
          }`}
        >
          {title}
        </h3>
        {description && (
          <p className="text-sm text-muted-foreground mb-4">{description}</p>
        )}
        <div className="flex flex-col gap-1">
          {options.map(option => (
            <button
              key={String(option.value)}
              onClick={() => onSelect(option.value)}
              className={`w-full text-left px-4 py-3 rounded-lg text-sm transition-colors ${
                selectedValue === option.value
                  ? 'bg-accent-soft text-accent-soft-foreground font-medium'
                  : 'hover:bg-muted text-foreground'
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

export default OptionBottomSheet;
