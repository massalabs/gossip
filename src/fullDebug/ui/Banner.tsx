/** The warning of the full debug build: full width, cannot be dismissed. */
import { useTranslation } from 'react-i18next';
import { FULL_DEBUG_NS, registerFullDebugTexts } from '../texts';

registerFullDebugTexts();

export default function FullDebugBanner() {
  const { t } = useTranslation(FULL_DEBUG_NS);
  return (
    <div
      role="alert"
      className="w-full bg-destructive text-white text-xs font-semibold leading-snug px-3 py-2 text-center"
    >
      {t('banner')}
    </div>
  );
}
