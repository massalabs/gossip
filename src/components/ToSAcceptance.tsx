import React, { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import tosContent from '../../TERMS_OF_SERVICE.md?raw';
import Button from './ui/Button';

interface ToSAcceptanceProps {
  onAccept: () => void;
}

const ToSAcceptance: React.FC<ToSAcceptanceProps> = ({ onAccept }) => {
  const { t } = useTranslation('onboarding');
  const [hasScrolledToBottom, setHasScrolledToBottom] = useState(false);
  const [checked, setChecked] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop <= el.clientHeight + 40;
    if (atBottom) setHasScrolledToBottom(true);
  };

  return (
    <div className="h-full min-h-0 flex flex-col md:p-8 p-safe-b  w-full mx-auto max-w-2xl px-4">
      <ToS onHasScrolledBottom={() => setHasScrolledToBottom(true)} />

      {/* Acceptance controls */}
      <div className="shrink-0 pt-4 space-y-4">
        {!hasScrolledToBottom ? (
          <p className="text-xs text-muted-foreground text-center">
            {t('tos.scroll_hint', 'Please scroll to the bottom to continue.')}
          </p>
        ) : (
          <label className="flex items-start gap-3 cursor-pointer select-none">
            <input
              type="checkbox"
              className="accent-primary mt-0.5 h-4 w-4 shrink-0"
              checked={checked}
              onChange={e => setChecked(e.target.checked)}
            />
            <span className="text-sm text-foreground leading-snug">
              {t(
                'tos.checkbox_label',
                'I have read and agree to the Terms of Service.'
              )}
            </span>
          </label>
        )}

        <Button
          onClick={onAccept}
          variant="primary"
          size="custom"
          fullWidth
          disabled={!checked}
          className="h-14 text-base font-semibold rounded-full"
        >
          {t('tos.accept_button', 'Accept & Continue')}
        </Button>
      </div>
    </div>
  );
};

export default ToSAcceptance;
