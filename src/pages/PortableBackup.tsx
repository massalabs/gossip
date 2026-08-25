import React, { useCallback, useEffect, useRef, useState } from 'react';
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

type Result = 'idle' | 'success' | 'failed' | 'cleanup-required';

const RECOVERY_KEY = 'gossip:portable-backup-result';

function storedResult(): Result {
  const value = window.sessionStorage.getItem(RECOVERY_KEY);
  return value === 'success' ||
    value === 'failed' ||
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
  const [destination, setDestination] = useState<FileSystemFileHandle | null>(
    null
  );
  const [progress, setProgress] = useState<PortableBackupProgress | null>(null);
  const initialResult = useRef(storedResult()).current;
  const [exporting, setExporting] = useState(false);
  const [terminalStarted, setTerminalStarted] = useState(
    initialResult !== 'idle'
  );
  const [result, setResult] = useState<Result>(initialResult);
  const abortRef = useRef<AbortController | null>(null);
  const allowRestartRef = useRef(false);
  const mountedRef = useRef(true);
  const supported = sdk.isSecureStorage && canStreamBrowserBackup();

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

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
    try {
      if (authenticated) await logout({ lockedByUser: true });
    } catch {
      // The runtime is terminal; a full restart is still the only safe exit.
    } finally {
      clearStoredResult();
      allowRestartRef.current = true;
      restartAfterPortableBackup(ROUTES.welcome());
    }
  }, [authenticated, logout]);

  const selectDestination = useCallback(async () => {
    try {
      const handle = await selectBrowserBackupDestination();
      setDestination(handle);
      setResult('idle');
      setProgress(null);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        setResult('failed');
      }
    }
  }, []);

  const exportBackup = useCallback(async () => {
    if (!destination || exporting) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setExporting(true);
    setTerminalStarted(true);
    persistResult('cleanup-required');
    setResult('idle');
    setProgress(null);
    try {
      await exportBrowserBackup(
        sdk,
        destination,
        setProgress,
        controller.signal
      );
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
  }, [destination, exporting, sdk]);

  const retry = useCallback(() => {
    clearStoredResult();
    allowRestartRef.current = true;
    restartAfterPortableBackup(ROUTES.portableBackup());
  }, []);

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
          <Button fullWidth onClick={() => void returnToLogin()}>
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

        {!supported ? (
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
                  ? t('portable_backup.cleanup_required')
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
              ) : result === 'failed' || result === 'cleanup-required' ? (
                <>
                  <Button fullWidth onClick={retry}>
                    {t('portable_backup.retry')}
                  </Button>
                  <Button
                    variant="outline"
                    fullWidth
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
