import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { CheckCircle, Download, AlertTriangle } from 'react-feather';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import Button from '../components/ui/Button';
import PageLayout from '../components/ui/Layout/PageLayout';
import PageHeader from '../components/ui/PageHeader';
import { ROUTES } from '../constants/routes';
import { useGossipSdk } from '../hooks/useGossipSdk';
import {
  exportBrowserBackup,
  canStreamBrowserBackup,
  PortableBackupCleanupRequiredError,
  restartAfterPortableBackup,
  selectBrowserBackupDestination,
  type PortableBackupProgress,
} from '../services/portableBackup';
import {
  abandonNativeBackupDestination,
  cleanupInterruptedNativeBackups,
  exportNativeBackup,
  forgetInterruptedNativeBackups,
  listInterruptedNativeBackups,
  isNativeBackupSelectionCancellation,
  selectNativeBackupDestination,
  type NativeBackupDestination,
} from '../services/portableBackupNative';
import { useAccountStore } from '../stores/accountStore';

const formatter = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 1,
});

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${formatter.format(value)} ${unit}`;
}

type Result =
  | 'idle'
  | 'success'
  | 'failed'
  | 'interrupted'
  | 'cleanup-required';

type BackupDestination =
  | { kind: 'browser'; handle: FileSystemFileHandle; name: string }
  | { kind: 'native'; handle: NativeBackupDestination; name: string };

const RECOVERY_KEY = 'gossip:portable-backup-result';

function storedResult(): Result {
  const value = window.sessionStorage.getItem(RECOVERY_KEY);
  return value === 'success' ||
    value === 'failed' ||
    value === 'interrupted' ||
    value === 'cleanup-required'
    ? value
    : 'idle';
}

function persistResult(result: Exclude<Result, 'idle'>): void {
  window.sessionStorage.setItem(RECOVERY_KEY, result);
}

function clearStoredResult(): void {
  window.sessionStorage.removeItem(RECOVERY_KEY);
}

const PortableBackup: React.FC = () => {
  const { t } = useTranslation('settings');
  const navigate = useNavigate();
  const sdk = useGossipSdk();
  const logout = useAccountStore(state => state.logout);
  const authenticated = useAccountStore(state => state.userProfile !== null);
  const [destination, setDestination] = useState<BackupDestination | null>(
    null
  );
  const [progress, setProgress] = useState<PortableBackupProgress | null>(null);
  const initialResult = useRef(storedResult()).current;
  const [exporting, setExporting] = useState(false);
  const [terminalStarted, setTerminalStarted] = useState(
    initialResult !== 'idle'
  );
  const [result, setResult] = useState<Result>(initialResult);
  const [recoveryName, setRecoveryName] = useState<string | null>(null);
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const destinationRef = useRef<BackupDestination | null>(null);
  const terminalStartedRef = useRef(initialResult !== 'idle');
  const allowRestartRef = useRef(false);
  const mountedRef = useRef(true);
  const platform = Capacitor.getPlatform();
  const nativePlatform = platform === 'android' || platform === 'ios';
  const supported =
    sdk.isSecureStorage &&
    (nativePlatform || (platform === 'web' && canStreamBrowserBackup()));

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
      const currentDestination = destinationRef.current;
      if (
        currentDestination?.kind === 'native' &&
        !terminalStartedRef.current
      ) {
        void abandonNativeBackupDestination(currentDestination.handle).catch(
          () => false
        );
      }
    };
  }, []);

  useEffect(() => {
    if (!nativePlatform) return;
    void listInterruptedNativeBackups().then(outputs => {
      if (outputs.length === 0 || !mountedRef.current) return;
      setRecoveryName(outputs.map(output => output.name).join(', '));
      if (initialResult !== 'idle') return;
      persistResult('interrupted');
      terminalStartedRef.current = true;
      setTerminalStarted(true);
      setResult('interrupted');
    });
  }, [initialResult, nativePlatform]);

  useEffect(() => {
    if (!terminalStarted) return;
    const currentUrl = window.location.href;
    const guard = () => {
      window.history.pushState({ portableBackup: true }, '', currentUrl);
    };
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (allowRestartRef.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    guard();
    window.addEventListener('popstate', guard);
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      window.removeEventListener('popstate', guard);
      window.removeEventListener('beforeunload', beforeUnload);
    };
  }, [terminalStarted]);

  const returnToLogin = useCallback(async () => {
    if (recoveryBusy) return;
    setRecoveryBusy(true);
    try {
      if (nativePlatform && result === 'interrupted') {
        const cleanup = await cleanupInterruptedNativeBackups().catch(() => ({
          cleaned: false,
          remaining: [] as NativeBackupDestination[],
        }));
        if (!cleanup.cleaned) {
          if (cleanup.remaining.length > 0) {
            setRecoveryName(
              cleanup.remaining.map(output => output.name).join(', ')
            );
          }
          persistResult('cleanup-required');
          setResult('cleanup-required');
          return;
        }
      } else if (nativePlatform && result === 'cleanup-required') {
        // The user-facing recovery text requires manual deletion before this
        // action. Forget only the device-local capability, never the file.
        await forgetInterruptedNativeBackups();
      }
      try {
        if (authenticated) await logout({ lockedByUser: true });
      } catch {
        // The runtime is terminal; a full restart is still the only safe exit.
      }
      clearStoredResult();
      allowRestartRef.current = true;
      restartAfterPortableBackup(ROUTES.welcome());
    } finally {
      if (mountedRef.current) setRecoveryBusy(false);
    }
  }, [authenticated, logout, nativePlatform, recoveryBusy, result]);

  const selectDestination = useCallback(async () => {
    try {
      if (nativePlatform) {
        const handle = await selectNativeBackupDestination();
        const previous = destinationRef.current;
        if (previous?.kind === 'native') {
          const released = await abandonNativeBackupDestination(
            previous.handle
          );
          if (!released) {
            await abandonNativeBackupDestination(handle).catch(() => false);
            throw new Error(
              'Unable to release the previous backup destination'
            );
          }
        }
        const selected = {
          kind: 'native',
          handle,
          name: handle.name,
        } as const;
        destinationRef.current = selected;
        setDestination(selected);
      } else {
        const handle = await selectBrowserBackupDestination();
        const selected = {
          kind: 'browser',
          handle,
          name: handle.name,
        } as const;
        destinationRef.current = selected;
        setDestination(selected);
      }
      setResult('idle');
      setProgress(null);
    } catch (error) {
      if (
        !(error instanceof DOMException && error.name === 'AbortError') &&
        !isNativeBackupSelectionCancellation(error)
      ) {
        setResult('failed');
      }
    }
  }, [nativePlatform]);

  const exportBackup = useCallback(async () => {
    if (!destination || exporting) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setExporting(true);
    terminalStartedRef.current = true;
    setTerminalStarted(true);
    persistResult('cleanup-required');
    setResult('idle');
    setProgress(null);
    try {
      if (destination.kind === 'native') {
        await exportNativeBackup(
          sdk,
          destination.handle,
          {
            notificationTitle: t('portable_backup.notification_title'),
            preparing: t('portable_backup.preparing'),
            writing: t('portable_backup.writing'),
            verifying: t('portable_backup.verifying'),
          },
          setProgress,
          controller.signal
        );
      } else {
        await exportBrowserBackup(
          sdk,
          destination.handle,
          setProgress,
          controller.signal
        );
      }
      persistResult('success');
      setResult('success');
    } catch (error) {
      const failure =
        error instanceof PortableBackupCleanupRequiredError
          ? 'cleanup-required'
          : 'failed';
      persistResult(failure);
      setResult(failure);
    } finally {
      abortRef.current = null;
      setExporting(false);
      if (!mountedRef.current) {
        allowRestartRef.current = true;
        restartAfterPortableBackup(ROUTES.portableBackup());
      }
    }
  }, [destination, exporting, sdk, t]);

  const retry = useCallback(async () => {
    if (recoveryBusy) return;
    setRecoveryBusy(true);
    try {
      if (nativePlatform) {
        const cleanup = await cleanupInterruptedNativeBackups().catch(() => ({
          cleaned: false,
          remaining: [] as NativeBackupDestination[],
        }));
        if (!cleanup.cleaned) {
          if (cleanup.remaining.length > 0) {
            setRecoveryName(
              cleanup.remaining.map(output => output.name).join(', ')
            );
          }
          persistResult('cleanup-required');
          setResult('cleanup-required');
          return;
        }
      }
      clearStoredResult();
      allowRestartRef.current = true;
      restartAfterPortableBackup(ROUTES.portableBackup());
    } finally {
      if (mountedRef.current) setRecoveryBusy(false);
    }
  }, [nativePlatform, recoveryBusy]);

  if (result === 'success') {
    return (
      <PageLayout contentClassName="px-6 py-8">
        <div className="app-max-w mx-auto min-h-full flex flex-col justify-center text-center gap-6">
          <CheckCircle className="w-16 h-16 text-success mx-auto" />
          <div className="space-y-2">
            <h1 className="text-2xl font-bold text-foreground">
              {t('portable_backup.success_title')}
            </h1>
            <p className="text-sm text-muted-foreground leading-relaxed">
              {t('portable_backup.success_body')}
            </p>
          </div>
          <Button
            fullWidth
            disabled={recoveryBusy}
            onClick={() => void returnToLogin()}
          >
            {t('portable_backup.continue_login')}
          </Button>
        </div>
      </PageLayout>
    );
  }

  return (
    <PageLayout
      header={
        <PageHeader
          title={t('portable_backup.title')}
          onBack={
            terminalStarted
              ? undefined
              : () =>
                  navigate(authenticated ? ROUTES.settings() : ROUTES.welcome())
          }
        />
      }
      className="app-max-w mx-auto"
      contentClassName="px-6 py-6"
    >
      <div className="space-y-5">
        <div className="rounded-2xl border border-border bg-card p-5 space-y-3 shadow-sm dark:shadow-none">
          <div className="flex items-start gap-3">
            <Download className="w-6 h-6 text-primary shrink-0 mt-0.5" />
            <div className="space-y-1">
              <h2 className="font-semibold text-foreground">
                {t('portable_backup.all_accounts_title')}
              </h2>
              <p className="text-sm text-muted-foreground leading-relaxed">
                {t('portable_backup.description')}
              </p>
            </div>
          </div>
        </div>

        <div className="rounded-2xl border border-warning/40 bg-warning/10 p-4 flex gap-3">
          <AlertTriangle className="w-5 h-5 text-warning shrink-0 mt-0.5" />
          <div className="space-y-2 text-sm leading-relaxed">
            <p className="font-semibold text-foreground">
              {t('portable_backup.important')}
            </p>
            <p className="text-muted-foreground">
              {t('portable_backup.possession_warning')}
            </p>
          </div>
        </div>

        {!supported &&
        result !== 'interrupted' &&
        result !== 'cleanup-required' ? (
          <p className="rounded-xl border border-border bg-muted p-4 text-sm text-muted-foreground">
            {t('portable_backup.unsupported')}
          </p>
        ) : (
          <>
            <Button
              variant="outline"
              fullWidth
              disabled={exporting || terminalStarted}
              onClick={() => void selectDestination()}
            >
              {destination
                ? t('portable_backup.change_destination')
                : t('portable_backup.choose_destination')}
            </Button>

            {destination && (
              <div className="rounded-xl border border-border bg-card px-4 py-3">
                <p className="text-xs text-muted-foreground">
                  {t('portable_backup.destination')}
                </p>
                <p className="text-sm font-medium text-foreground truncate mt-1">
                  {destination.name}
                </p>
              </div>
            )}

            {exporting && progress && (
              <div className="space-y-2" aria-live="polite">
                <div className="flex justify-between gap-3 text-sm">
                  <span className="font-medium text-foreground">
                    {progress.phase === 'writing'
                      ? t('portable_backup.writing')
                      : t('portable_backup.verifying')}
                  </span>
                  <span className="text-muted-foreground tabular-nums">
                    {formatBytes(progress.processedBytes)} /{' '}
                    {formatBytes(progress.totalBytes)}
                  </span>
                </div>
                <div className="h-2 rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full bg-primary transition-[width] duration-200"
                    style={{
                      width: `${Math.min(
                        100,
                        (progress.processedBytes / progress.totalBytes) * 100
                      )}%`,
                    }}
                  />
                </div>
              </div>
            )}

            {result !== 'idle' && (
              <div
                role="alert"
                className="rounded-xl border border-destructive/40 bg-destructive/10 p-4 text-sm text-foreground leading-relaxed"
              >
                {result === 'cleanup-required'
                  ? t('portable_backup.cleanup_required', {
                      name:
                        recoveryName ??
                        destination?.name ??
                        t('portable_backup.selected_file'),
                    })
                  : result === 'interrupted'
                    ? t('portable_backup.interrupted', {
                        name:
                          recoveryName ??
                          destination?.name ??
                          t('portable_backup.selected_file'),
                      })
                    : t('portable_backup.failed')}
              </div>
            )}

            <div className="space-y-3 pt-1">
              {exporting ? (
                <Button
                  variant="outline"
                  fullWidth
                  onClick={() => abortRef.current?.abort()}
                >
                  {t('common:cancel')}
                </Button>
              ) : result === 'failed' ||
                result === 'interrupted' ||
                result === 'cleanup-required' ? (
                <>
                  <Button
                    fullWidth
                    disabled={recoveryBusy}
                    onClick={() => void retry()}
                  >
                    {t('portable_backup.retry')}
                  </Button>
                  <Button
                    variant="outline"
                    fullWidth
                    disabled={recoveryBusy}
                    onClick={() => void returnToLogin()}
                  >
                    {t('portable_backup.continue_login')}
                  </Button>
                </>
              ) : (
                <Button
                  fullWidth
                  disabled={!destination}
                  onClick={() => void exportBackup()}
                >
                  {t('portable_backup.export')}
                </Button>
              )}
            </div>
          </>
        )}
      </div>
    </PageLayout>
  );
};

export default PortableBackup;
