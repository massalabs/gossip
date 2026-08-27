import React, { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import LoadingScreen from './ui/LoadingScreen';
import PortableBackup from '../pages/PortableBackup';
import { listInterruptedNativeBackups } from '../services/portableBackupNative';
import {
  clearPortableImportCleanupPending,
  isPortableImportCleanupPending,
  runPortableImportPostCommitCleanup,
  unblockPortableImportAccountOutputs,
} from '../services/portableImportCleanup';
import { getSdk } from '../stores/sdkStore';
import Button from './ui/Button';
import { useTranslation } from 'react-i18next';

const RECOVERY_KEY = 'gossip:portable-backup-result';

function isNativePlatform(): boolean {
  const platform = Capacitor.getPlatform();
  return platform === 'android' || platform === 'ios';
}

/** Block every account route until the native device-local output journal is clear. */
const PortableBackupStartupGate: React.FC<React.PropsWithChildren> = ({
  children,
}) => {
  const { t } = useTranslation('auth');
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<
    'checking' | 'required' | 'cleanup-failed' | 'clear'
  >(
    isNativePlatform() || isPortableImportCleanupPending()
      ? 'checking'
      : 'clear'
  );

  useEffect(() => {
    let active = true;
    const check = async () => {
      const cleanupPending = isPortableImportCleanupPending();
      if (!cleanupPending && !isNativePlatform()) {
        if (active) setState('clear');
        return;
      }
      setState('checking');
      if (cleanupPending) {
        const imported = await getSdk().wasPortableImportInstalled();
        if (imported) {
          await runPortableImportPostCommitCleanup();
          window.location.reload();
          return;
        } else {
          await unblockPortableImportAccountOutputs();
          clearPortableImportCleanupPending();
        }
      }
      if (!isNativePlatform()) {
        if (active) setState('clear');
        return;
      }
      const outputs = await listInterruptedNativeBackups();
      if (!active) return;
      if (outputs.length > 0) {
        window.sessionStorage.setItem(RECOVERY_KEY, 'interrupted');
        setState('required');
      } else {
        setState('clear');
      }
    };
    void check().catch(() => {
      if (!active) return;
      if (isPortableImportCleanupPending()) {
        setState('cleanup-failed');
      } else {
        window.sessionStorage.setItem(RECOVERY_KEY, 'cleanup-required');
        setState('required');
      }
    });
    return () => {
      active = false;
    };
  }, [retry]);

  if (state === 'checking') return <LoadingScreen />;
  if (state === 'cleanup-failed') {
    return (
      <div className="app-max-w mx-auto flex min-h-dvh flex-col items-center justify-center gap-4 p-6 text-center">
        <p className="text-sm text-muted-foreground">
          {t('import.cleanup_failed')}
        </p>
        <Button fullWidth onClick={() => setRetry(value => value + 1)}>
          {t('import.retry_cleanup')}
        </Button>
      </div>
    );
  }
  if (state === 'required') return <PortableBackup />;
  return children;
};

export default PortableBackupStartupGate;
