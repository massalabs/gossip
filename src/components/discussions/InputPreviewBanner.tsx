import React, { useCallback } from 'react';
import { X } from 'react-feather';

interface InputPreviewBannerProps {
  isVisible: boolean;
  label: string;
  content: string;
  onCancel?: () => void;
  cancelAriaLabel?: string;
}

const InputPreviewBanner: React.FC<InputPreviewBannerProps> = ({
  isVisible,
  label,
  content,
  onCancel,
  cancelAriaLabel,
}) => {
  const handleCancel = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      onCancel?.();
    },
    [onCancel]
  );

  return (
    <div
      className={`overflow-hidden transition-all duration-200 ease-out ${
        isVisible ? 'max-h-20 opacity-100 mb-2' : 'max-h-0 opacity-0 mb-0'
      }`}
    >
      {isVisible && (
        <div className="px-3 py-2 bg-muted/50 border-l-2 border-primary rounded-r-lg">
          <div className="flex items-start justify-between gap-2">
            <div className="flex-1 min-w-0">
              <p className="text-[10px] text-muted-foreground font-medium mb-0.5">
                {label}
              </p>
              <p className="text-xs text-foreground/80 truncate">{content}</p>
            </div>
            {onCancel && (
              <button
                onClick={handleCancel}
                className="shrink-0 p-1.5 hover:bg-muted rounded-full transition-colors active:scale-90"
                aria-label={cancelAriaLabel}
              >
                <X className="w-4 h-4 text-muted-foreground" />
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default InputPreviewBanner;
