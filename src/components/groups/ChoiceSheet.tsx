import React, { useEffect, useState } from 'react';

export interface Choice {
  key: string;
  label: string;
  description?: string;
  danger?: boolean;
  /** Shown above this choice, after a separator (e.g. "Danger zone"). */
  sectionTitle?: string;
}

interface ChoiceSheetProps {
  isOpen: boolean;
  title: string;
  choices: Choice[];
  onSelect: (key: string) => void;
  onClose: () => void;
}

const EXIT_ANIMATION_MS = 250;

/**
 * Bottom sheet of described choices, laid out like `OptionBottomSheet`, for
 * the leave, decline and dissolve popups of groups (§5.2, §5.8), whose
 * choices carry an explanation and may sit in a danger zone.
 */
const ChoiceSheet: React.FC<ChoiceSheetProps> = ({
  isOpen,
  title,
  choices,
  onSelect,
  onClose,
}) => {
  const [render, setRender] = useState(isOpen);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setRender(true);
      const id = requestAnimationFrame(() => setMounted(true));
      return () => cancelAnimationFrame(id);
    }
    setMounted(false);
    const timer = setTimeout(() => setRender(false), EXIT_ANIMATION_MS);
    return () => clearTimeout(timer);
  }, [isOpen]);

  if (!render) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        className={`absolute inset-0 bg-black/50 transition-opacity duration-200 ${
          mounted ? 'opacity-100' : 'opacity-0'
        }`}
      />
      <div
        className={`relative bg-background w-full max-w-md rounded-t-2xl p-6 pb-8 max-h-[85vh] overflow-y-auto transform transition-transform duration-300 ease-out ${
          mounted ? 'translate-y-0' : 'translate-y-full'
        }`}
        onClick={e => e.stopPropagation()}
      >
        <h3 className="text-base font-semibold text-foreground mb-4">
          {title}
        </h3>
        <div className="flex flex-col gap-1">
          {choices.map(choice => (
            <React.Fragment key={choice.key}>
              {choice.sectionTitle && (
                <div className="mt-3 pt-3 border-t border-border">
                  <p className="px-4 pb-1 text-xs font-semibold uppercase tracking-wide text-destructive">
                    {choice.sectionTitle}
                  </p>
                </div>
              )}
              <button
                type="button"
                onClick={() => onSelect(choice.key)}
                className="w-full text-left px-4 py-3 rounded-lg transition-colors active:scale-[0.98] hover:bg-muted"
              >
                <span
                  className={`block text-sm font-medium ${
                    choice.danger ? 'text-destructive' : 'text-foreground'
                  }`}
                >
                  {choice.label}
                </span>
                {choice.description && (
                  <span className="block mt-1 text-xs text-muted-foreground">
                    {choice.description}
                  </span>
                )}
              </button>
            </React.Fragment>
          ))}
        </div>
      </div>
    </div>
  );
};

export default ChoiceSheet;
