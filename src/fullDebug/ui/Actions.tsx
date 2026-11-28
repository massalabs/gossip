/**
 * Buttons of the full debug build: "Send debug logs" (login screens and
 * debug settings) and, in the debug settings, a test error and the space
 * kept for the logs.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FULL_DEBUG_NS, registerFullDebugTexts } from '../texts';
import { fullDebug, openSendDialog } from '../state';
import { recentSends } from '../sentRefs';
import CopyRef from './CopyRef';

registerFullDebugTexts();

const GIB = 1024 * 1024 * 1024;
const CAP_CHOICES = [1, 2, 5];
const CAP_KEY = 'gossip-full-debug-cap-gib';

export default function FullDebugActions({
  settings = false,
}: {
  settings?: boolean;
}) {
  const { t } = useTranslation(FULL_DEBUG_NS);
  const [cap, setCap] = useState<number>(() => {
    try {
      return Number(localStorage.getItem(CAP_KEY) ?? '5') || 5;
    } catch {
      return 5;
    }
  });
  useEffect(() => {
    if (!settings) return;
    void fullDebug.backend?.setCap(cap * GIB).catch(() => {});
  }, [cap, settings]);

  return (
    <div className="w-full space-y-2">
      <button
        type="button"
        className="w-full rounded-full border border-destructive text-destructive px-4 py-2 text-sm font-medium"
        onClick={openSendDialog}
      >
        {t('send_button')}
      </button>
      {settings && (
        <>
          <button
            type="button"
            className="w-full rounded-full border border-border px-4 py-2 text-sm"
            onClick={() => {
              // An uncaught error, as a real bug would raise it.
              setTimeout(() => {
                throw new Error(t('test_error_message'));
              }, 0);
            }}
          >
            {t('test_error_button')}
          </button>
          <label className="flex items-center justify-between gap-2 text-sm px-1">
            <span>{t('cap_label')}</span>
            <select
              className="rounded border border-border bg-background px-2 py-1"
              value={cap}
              onChange={e => {
                const v = Number(e.target.value);
                setCap(v);
                try {
                  localStorage.setItem(CAP_KEY, String(v));
                } catch {
                  // ignore
                }
              }}
            >
              {CAP_CHOICES.map(g => (
                <option key={g} value={g}>
                  {g} GiB
                </option>
              ))}
            </select>
          </label>
          <LastSends />
        </>
      )}
    </div>
  );
}

/** The references of the last sends, to give to the developers. */
function LastSends() {
  const { t } = useTranslation(FULL_DEBUG_NS);
  const [sends] = useState(recentSends);
  if (sends.length === 0) return null;
  return (
    <div className="px-1 pt-2 text-sm">
      <p className="font-medium">{t('last_sends')}</p>
      <ul className="space-y-2">
        {sends.map(s => (
          <li key={s.ref} className="text-xs text-muted-foreground">
            {new Date(s.at).toLocaleString()}
            <CopyRef value={s.ref} />
          </li>
        ))}
      </ul>
    </div>
  );
}
