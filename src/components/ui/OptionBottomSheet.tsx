import React, { useEffect, useId, useRef, useState } from 'react';

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

const EXIT_ANIMATION_MS = 250;

/**
 * Bottom-sheet single-choice picker shared by the retention and auto-lock
 * settings (previously copy-pasted on four pages) and the message timers.
 *
 * The sheet is never taller than the screen below its safe area: the title
 * stays in view and the list scrolls, starting with the current choice in
 * view.
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
  // `render` keeps the sheet mounted during the exit transition;
  // `mounted` drives the enter/exit transition classes.
  const [render, setRender] = useState(isOpen);
  const [mounted, setMounted] = useState(false);
  const titleId = useId();
  const selectedRef = useRef<HTMLButtonElement | null>(null);

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

  // The current choice in view when the sheet opens (the list may be longer
  // than the screen).
  useEffect(() => {
    if (render) selectedRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [render]);

  if (!render) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center"
      onClick={onClose}
    >
      <div
        className={`absolute inset-0 bg-black/50 transition-opacity duration-200 ${
          mounted ? 'opacity-100' : 'opacity-0'
        }`}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`relative flex flex-col bg-background w-full max-w-md rounded-t-2xl p-6 pb-8 transform transition-transform duration-300 ease-out ${
          mounted ? 'translate-y-0' : 'translate-y-full'
        }`}
        style={{
          maxHeight: 'calc(100dvh - env(safe-area-inset-top, 0px) - 1rem)',
          paddingBottom: 'calc(2rem + env(safe-area-inset-bottom, 0px))',
        }}
        onClick={e => e.stopPropagation()}
      >
        <h3
          id={titleId}
          className={`shrink-0 text-base font-semibold text-foreground ${
            description ? 'mb-1' : 'mb-4'
          }`}
        >
          {title}
        </h3>
        {description && (
          <p className="shrink-0 text-sm text-muted-foreground mb-4">
            {description}
          </p>
        )}
        <div className="flex flex-col gap-1 min-h-0 overflow-y-auto overscroll-contain">
          {options.map(option => (
            <button
              key={String(option.value)}
              ref={
                selectedValue === option.value
                  ? el => {
                      selectedRef.current = el;
                    }
                  : undefined
              }
              aria-pressed={selectedValue === option.value}
              onClick={() => onSelect(option.value)}
              className={`w-full text-left px-4 py-3 rounded-lg text-sm transition-colors active:scale-[0.98] ${
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
