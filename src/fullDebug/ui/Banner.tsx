/**
 * The warning of the full debug build: full width, cannot be dismissed. In
 * the layout flow (it pushes the screen down, never covers it). Near-black
 * on amber in both themes, for contrast. `safeTop` when it is the first
 * thing on screen: it then starts below the status bar (Android 15
 * edge-to-edge, iOS notch), like the app's own top bars (`--sat`).
 */
import { useTranslation } from 'react-i18next';
import { FULL_DEBUG_NS, registerFullDebugTexts } from '../texts';

registerFullDebugTexts();

export default function FullDebugBanner({
  safeTop = false,
}: {
  safeTop?: boolean;
}) {
  const { t } = useTranslation(FULL_DEBUG_NS);
  return (
    <div
      role="alert"
      className={`w-full shrink-0 bg-amber-400 text-neutral-950 text-[11px] font-semibold leading-tight px-3 pb-1.5 text-center ${
        safeTop ? 'pt-[calc(var(--sat)+0.375rem)]' : 'pt-1.5'
      }`}
    >
      {t('banner')}
    </div>
  );
}
