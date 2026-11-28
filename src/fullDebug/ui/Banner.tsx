/**
 * The warning of the full debug build, rendered once above every screen of
 * the app (FullDebugFrame in ../lazy.tsx), so that no screen can miss it. It
 * starts below the status bar (top safe-area inset; Android 15
 * edge-to-edge, iOS notch) and pushes the app down. Black on amber in
 * both themes, for contrast. Before login (login, onboarding) it shows the
 * full text; after login one line, with the full text on tap, so that it
 * takes little of the chat screens.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FULL_DEBUG_NS, registerFullDebugTexts } from '../texts';
import { useAccountStore } from '../../stores/accountStore';

registerFullDebugTexts();

export default function FullDebugBanner() {
  const { t } = useTranslation(FULL_DEBUG_NS);
  const loggedIn = useAccountStore(s => s.userProfile !== null);
  const [open, setOpen] = useState(false);
  const full = !loggedIn || open;
  return (
    <div
      role="alert"
      className="w-full shrink-0 bg-[#fbbf24] text-[#000] text-[11px] font-semibold leading-tight px-3 pb-1 pt-[calc(var(--sat)+0.25rem)] text-center"
      onClick={loggedIn ? () => setOpen(o => !o) : undefined}
      aria-expanded={loggedIn ? open : undefined}
    >
      {full ? (
        t('banner')
      ) : (
        <span className="block truncate">
          {t('banner_short')}
          <span className="font-normal"> · {t('banner_more')}</span>
        </span>
      )}
    </div>
  );
}
