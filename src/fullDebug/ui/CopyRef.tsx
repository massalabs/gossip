/** A send's reference: tap to copy it, with a short "Copied". */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FULL_DEBUG_NS } from '../texts';

export default function CopyRef({ value }: { value: string }) {
  const { t } = useTranslation(FULL_DEBUG_NS);
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const timer = setTimeout(() => setState('idle'), 2000);
    return () => clearTimeout(timer);
  }, [state]);
  return (
    <button
      type="button"
      className="mt-1 w-full rounded-lg border border-border bg-background px-2 py-1.5 text-left font-mono text-xs break-all select-text"
      aria-label={t('copy_ref')}
      onClick={() => {
        navigator.clipboard
          .writeText(value)
          .then(() => setState('copied'))
          .catch(() => setState('failed'));
      }}
    >
      {value}
      <span className="block font-sans text-[11px] text-muted-foreground">
        {state === 'copied'
          ? t('copied')
          : state === 'failed'
            ? t('copy_failed')
            : t('copy_ref')}
      </span>
    </button>
  );
}
