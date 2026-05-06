import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Battery, Zap } from 'react-feather';
import PageLayout from '../ui/Layout/PageLayout';
import Button from '../ui/Button';
import Toggle from '../ui/Toggle';
import { ForegroundSync } from '../../services/foregroundSync';
import { setBackgroundSyncPreset } from '../../utils/preferences';

interface Props {
  // Promise the parent kicked off in parallel with this screen — typically
  // `finalizeOnboarding`. Awaited before letting the user through so the
  // session is fully wired (polling running, lastSeen bumped) by the time
  // the authenticated app mounts.
  finalizingPromise: Promise<void>;
  onDone: () => void;
}

const BackgroundSyncOnboarding: React.FC<Props> = ({
  finalizingPromise,
  onDone,
}) => {
  const { t } = useTranslation('auth');
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);

  const handleToggle = async (next: boolean) => {
    setEnabled(next);
    try {
      if (next) {
        // Tightest tick interval — the user opted into max reliability.
        await setBackgroundSyncPreset('max');
        await ForegroundSync.start();
      } else {
        await ForegroundSync.stop();
      }
    } catch (e) {
      console.error('Foreground sync toggle failed:', e);
      setEnabled(!next);
    }
  };

  const handleContinue = async () => {
    setBusy(true);
    try {
      await finalizingPromise;
    } finally {
      onDone();
    }
  };

  return (
    <PageLayout
      className="app-max-w mx-auto"
      contentClassName="px-6 py-8 flex flex-col gap-6"
    >
      <div className="flex flex-col items-center text-center gap-4">
        <Battery className="w-12 h-12 text-foreground" />
        <h1 className="text-xl font-semibold text-foreground">
          {t('background_sync_title')}
        </h1>
        <p className="text-sm text-muted-foreground leading-relaxed">
          {t('background_sync_description')}
        </p>
      </div>

      <div className="bg-card border border-border rounded-xl flex items-center gap-4 px-4 py-4">
        <Zap className="w-5 h-5 text-foreground shrink-0" />
        <span className="flex-1 text-sm font-medium text-foreground">
          {t('background_sync_toggle')}
        </span>
        <Toggle
          checked={enabled}
          onChange={handleToggle}
          ariaLabel={t('background_sync_toggle')}
        />
      </div>

      <div className="mt-auto">
        <Button
          onClick={handleContinue}
          loading={busy}
          variant="primary"
          size="custom"
          fullWidth
          className="h-12 rounded-full text-sm font-medium"
        >
          {t('background_sync_continue')}
        </Button>
      </div>
    </PageLayout>
  );
};

export default BackgroundSyncOnboarding;
