import React, { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import LoadingScreen from './ui/LoadingScreen';
import PortableBackup from '../pages/PortableBackup';
import { listInterruptedNativeBackups } from '../services/portableBackupNative';

const RECOVERY_KEY = 'gossip:portable-backup-result';

function isNativePlatform(): boolean {
  const platform = Capacitor.getPlatform();
  return platform === 'android' || platform === 'ios';
}

/** Block every account route until the native device-local output journal is clear. */
const PortableBackupStartupGate: React.FC<React.PropsWithChildren> = ({
  children,
}) => {
  const [state, setState] = useState<'checking' | 'required' | 'clear'>(
    isNativePlatform() ? 'checking' : 'clear'
  );

  useEffect(() => {
    if (!isNativePlatform()) return;
    let active = true;
    void listInterruptedNativeBackups()
      .then(outputs => {
        if (!active) return;
        if (outputs.length > 0) {
          window.sessionStorage.setItem(RECOVERY_KEY, 'interrupted');
          setState('required');
        } else {
          setState('clear');
        }
      })
      .catch(() => {
        if (!active) return;
        // Fail closed: a journal read error must not expose account routes
        // while an incomplete external backup may still exist.
        window.sessionStorage.setItem(RECOVERY_KEY, 'cleanup-required');
        setState('required');
      });
    return () => {
      active = false;
    };
  }, []);

  if (state === 'checking') return <LoadingScreen />;
  if (state === 'required') return <PortableBackup />;
  return children;
};

export default PortableBackupStartupGate;
