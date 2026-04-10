import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import ToS from './ToS';
import Button from './ui/Button';

interface ToSAcceptanceProps {
  onAccept: () => void;
}

const ToSAcceptance: React.FC<ToSAcceptanceProps> = ({ onAccept }) => {
  const { t } = useTranslation('onboarding');
  const [hasScrolledToBottom, setHasScrolledToBottom] = useState(false);
  const [checked, setChecked] = useState(false);

  return (
    <div className="h-full min-h-0 flex flex-col p-4 md:p-8 py-10 w-full mx-auto max-w-2xl">
      <ToS onHasScrolledBottom={() => setHasScrolledToBottom(true)} />

      {/* Acceptance controls */}
      <div className="shrink-0 pt-4 space-y-4">
        {!hasScrolledToBottom && (
          <p className="text-xs text-muted-foreground text-center">
            {t('tos.scroll_hint', 'Please scroll to the bottom to continue.')}
          </p>
        )}

        <label className="flex items-start gap-3 cursor-pointer select-none">
          <input
            type="checkbox"
            className="mt-1 accent-primary"
            checked={checked}
            disabled={!hasScrolledToBottom}
            onChange={e => setChecked(e.target.checked)}
          />
          <span className="text-sm text-foreground">
            {t(
              'tos.checkbox_label',
              'I have read and agree to the Terms of Service.'
            )}
          </span>
        </label>

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
