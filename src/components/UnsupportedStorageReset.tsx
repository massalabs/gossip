import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Button from './ui/Button';
import {
  isUnsupportedStorageResetConfirmed,
  resetUnsupportedSecureStorage,
} from '../services/unsupportedStorageReset';

export default function UnsupportedStorageReset() {
  const { t } = useTranslation('auth');
  const confirmed = isUnsupportedStorageResetConfirmed();
  const [confirming, setConfirming] = useState(confirmed);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const reset = async () => {
    setBusy(true);
    setFailed(false);
    try {
      await resetUnsupportedSecureStorage();
    } catch {
      setFailed(true);
      setBusy(false);
    }
  };

  useEffect(() => {
    if (confirmed) void reset();
    // Confirmed recovery is a one-shot startup action.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <main className="flex min-h-dvh items-center justify-center bg-white px-6 text-neutral-900 dark:bg-neutral-950 dark:text-white">
      <section className="w-full max-w-md space-y-6 rounded-3xl border border-neutral-200 bg-white p-6 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold">
            {t('unsupported_storage.title')}
          </h1>
          <p className="text-sm text-neutral-600 dark:text-neutral-300">
            {t('unsupported_storage.description')}
          </p>
        </div>

        {!confirming ? (
          <Button
            onClick={() => setConfirming(true)}
            variant="danger"
            fullWidth
          >
            {t('unsupported_storage.reset_action')}
          </Button>
        ) : (
          <div className="space-y-4 rounded-2xl border border-red-300 bg-red-50 p-4 dark:border-red-900 dark:bg-red-950/40">
            <p className="text-sm font-medium text-red-800 dark:text-red-200">
              {t('unsupported_storage.confirm_warning')}
            </p>
            <div className="grid grid-cols-2 gap-3">
              <Button
                onClick={() => setConfirming(false)}
                variant="secondary"
                disabled={busy}
              >
                {t('unsupported_storage.cancel')}
              </Button>
              <Button
                onClick={() => void reset()}
                variant="danger"
                disabled={busy}
              >
                {busy
                  ? t('unsupported_storage.resetting')
                  : t('unsupported_storage.confirm_action')}
              </Button>
            </div>
          </div>
        )}

        {failed && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-300">
            {t('unsupported_storage.failed')}
          </p>
        )}
      </section>
    </main>
  );
}
