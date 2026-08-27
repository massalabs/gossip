import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import {
  AlertTriangle,
  CheckCircle,
  FileText,
  Lock,
  Trash2,
  Upload,
} from 'react-feather';
import { useTranslation } from 'react-i18next';
import Button from '../components/ui/Button';
import RoundedInput from '../components/ui/RoundedInput';
import PageLayout from '../components/ui/Layout/PageLayout';
import PageHeader from '../components/ui/PageHeader';
import UserProfileAvatar from '../components/avatar/UserProfileAvatar';
import { ROUTES } from '../constants/routes';
import { useGossipSdk } from '../hooks/useGossipSdk';
import {
  canStreamBrowserImport,
  selectBrowserBackupSource,
  streamBrowserBackupImport,
  type PortableImportProgress,
} from '../services/portableImport';
import { createOnboardingPortableImportAuthorization } from '../services/portableImportAuthorization';
import { PortableImportCoordinator } from '../services/portableImportCoordinator';
import {
  isNativeBackupSelectionCancellation,
  releaseNativeBackupSource,
  selectNativeBackupSource,
  startNativeImportProtection,
  stopNativeImportProtection,
  streamNativeBackupImport,
  updateNativeImportProtection,
} from '../services/portableBackupNative';
import type { LoadedImportedAccountPreview } from '../services/importedAccountPreviews';
import { restartAfterPortableBackup } from '../services/portableBackup';
import { useAppStore } from '../stores/appStore';
import {
  blockPortableImportAccountOutputs,
  clearPortableImportCleanupPending,
  markPortableImportCleanupPending,
  runPortableImportPostCommitCleanup,
  unblockPortableImportAccountOutputs,
} from '../services/portableImportCleanup';

interface PortableImportProps {
  onBack: () => void;
}

type Phase =
  | 'idle'
  | 'reading'
  | 'passwords'
  | 'confirm'
  | 'installing'
  | 'cleanup'
  | 'restart'
  | 'success';

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

const PortableImport: React.FC<PortableImportProps> = ({ onBack }) => {
  const { t } = useTranslation('auth');
  const sdk = useGossipSdk();
  const [phase, setPhase] = useState<Phase>('idle');
  const [sourceName, setSourceName] = useState<string | null>(null);
  const [progress, setProgress] = useState<PortableImportProgress | null>(null);
  const [previews, setPreviews] = useState<LoadedImportedAccountPreview[]>([]);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [installAttempted, setInstallAttempted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const coordinatorRef = useRef<PortableImportCoordinator | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const phaseRef = useRef<Phase>('idle');
  const mountedRef = useRef(true);
  const operationGenerationRef = useRef(0);
  const runtimeStartedRef = useRef(false);
  const installPromiseRef = useRef<Promise<void> | null>(null);
  const postCommitCleanupRef = useRef(false);
  const outputUnblockRef = useRef(false);
  const platform = Capacitor.getPlatform();
  const nativePlatform = platform === 'android' || platform === 'ios';
  const supported = nativePlatform || canStreamBrowserImport();

  const updatePhase = useCallback((next: Phase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      operationGenerationRef.current += 1;
      abortRef.current?.abort();
      if (phaseRef.current === 'installing') {
        void installPromiseRef.current
          ?.catch(() => {})
          .finally(() => restartAfterPortableBackup(ROUTES.default()));
      } else if (phaseRef.current === 'success') {
        restartAfterPortableBackup(ROUTES.welcome());
      } else if (phaseRef.current !== 'restart') {
        const coordinator = coordinatorRef.current;
        if (runtimeStartedRef.current) {
          if (coordinator) {
            void coordinator
              .cancel()
              .catch(() => {})
              .finally(() => restartAfterPortableBackup(ROUTES.default()));
          } else {
            restartAfterPortableBackup(ROUTES.default());
          }
        } else {
          void coordinator?.cancel().catch(() => {});
        }
      }
    };
  }, []);

  const refreshPreviews = useCallback(() => {
    const coordinator = coordinatorRef.current;
    if (coordinator) setPreviews(coordinator.list());
  }, []);

  const selectAndValidate = useCallback(async () => {
    if (!supported || busy) return;
    const generation = operationGenerationRef.current + 1;
    operationGenerationRef.current = generation;
    const isCurrent = () =>
      mountedRef.current && operationGenerationRef.current === generation;
    setBusy(true);
    setError(null);
    setProgress(null);
    let coordinator: PortableImportCoordinator | null = null;
    let sourceSelected = false;
    let selectedNativeSource: Awaited<
      ReturnType<typeof selectNativeBackupSource>
    > | null = null;
    let nativeSourceHandedOff = false;
    try {
      const source = nativePlatform
        ? await selectNativeBackupSource()
        : await selectBrowserBackupSource();
      sourceSelected = true;
      if (nativePlatform) {
        selectedNativeSource = source as Awaited<
          ReturnType<typeof selectNativeBackupSource>
        >;
      }
      if (!isCurrent()) {
        if (selectedNativeSource) {
          await releaseNativeBackupSource(selectedNativeSource).catch(() => {});
        }
        return;
      }
      setSourceName(source.name);
      coordinator = await PortableImportCoordinator.begin(
        sdk,
        createOnboardingPortableImportAuthorization()
      );
      if (!isCurrent()) {
        await coordinator.cancel().catch(() => {});
        if (selectedNativeSource) {
          await releaseNativeBackupSource(selectedNativeSource).catch(() => {});
        }
        return;
      }
      coordinatorRef.current = coordinator;
      runtimeStartedRef.current = true;
      const controller = new AbortController();
      abortRef.current = controller;
      updatePhase('reading');
      if (nativePlatform) {
        nativeSourceHandedOff = true;
        await streamNativeBackupImport(
          source as Awaited<ReturnType<typeof selectNativeBackupSource>>,
          chunk => coordinator!.push(chunk),
          () => coordinator!.finishValidation(),
          (readBytes, totalBytes) => {
            if (isCurrent()) setProgress({ readBytes, totalBytes });
          },
          controller.signal,
          {
            notificationTitle: t('import.notification_title'),
            preparing: t('import.preparing'),
            writing: t('import.reading'),
            verifying: t('import.validating'),
          }
        );
      } else {
        await streamBrowserBackupImport(
          source as FileSystemFileHandle,
          chunk => coordinator!.push(chunk),
          () => coordinator!.finishValidation(),
          value => {
            if (isCurrent()) setProgress(value);
          },
          controller.signal
        );
      }
      if (!isCurrent()) {
        await coordinator.cancel().catch(() => {});
        return;
      }
      setInstallAttempted(false);
      updatePhase('passwords');
    } catch (caught) {
      if (selectedNativeSource && !nativeSourceHandedOff) {
        await releaseNativeBackupSource(selectedNativeSource).catch(() => {});
      }
      if (coordinator) {
        try {
          await coordinator.cancel();
          if (coordinatorRef.current === coordinator)
            coordinatorRef.current = null;
        } catch {
          if (isCurrent()) {
            coordinatorRef.current = coordinator;
            updatePhase('cleanup');
            setError(t('import.cleanup_failed'));
          }
          return;
        }
      }
      if (isCurrent()) {
        const startupAuthorityChanged =
          sourceSelected &&
          !coordinator &&
          caught instanceof Error &&
          /(authorized|authority|ownership|replaceable|already active|already started)/i.test(
            caught.message
          );
        if (startupAuthorityChanged) {
          restartAfterPortableBackup(ROUTES.default());
          return;
        }
        const ordinaryCancellation =
          (caught instanceof DOMException && caught.name === 'AbortError') ||
          isNativeBackupSelectionCancellation(caught);
        if (runtimeStartedRef.current) {
          updatePhase('restart');
          if (!ordinaryCancellation) setError(t('import.invalid_file'));
        } else {
          updatePhase('idle');
          if (!ordinaryCancellation) setError(t('import.invalid_file'));
        }
      }
    } finally {
      if (isCurrent()) {
        abortRef.current = null;
        setBusy(false);
      }
    }
  }, [busy, nativePlatform, sdk, supported, t, updatePhase]);

  const authenticate = useCallback(async () => {
    const coordinator = coordinatorRef.current;
    if (!coordinator || !password || busy) return;
    const submitted = password;
    setPassword('');
    setBusy(true);
    setError(null);
    try {
      await coordinator.authenticate(submitted);
      refreshPreviews();
    } catch {
      setError(t('import.invalid_password'));
    } finally {
      setBusy(false);
    }
  }, [busy, password, refreshPreviews, t]);

  const removePreview = useCallback(
    (preview: LoadedImportedAccountPreview) => {
      try {
        coordinatorRef.current?.remove(preview.passwordId);
        refreshPreviews();
      } catch {
        setError(t('import.failed'));
      }
    },
    [refreshPreviews, t]
  );

  const cancel = useCallback(async () => {
    if (phase === 'installing') return;
    if (outputUnblockRef.current) {
      setBusy(true);
      setError(null);
      try {
        await unblockPortableImportAccountOutputs();
        clearPortableImportCleanupPending();
        outputUnblockRef.current = false;
        updatePhase('confirm');
        setError(t('import.install_failed'));
      } catch {
        setError(t('import.cleanup_failed'));
      } finally {
        setBusy(false);
      }
      return;
    }
    if (postCommitCleanupRef.current) {
      setBusy(true);
      setError(null);
      try {
        await runPortableImportPostCommitCleanup();
        postCommitCleanupRef.current = false;
        updatePhase('success');
      } catch {
        setError(t('import.cleanup_failed'));
      } finally {
        setBusy(false);
      }
      return;
    }
    operationGenerationRef.current += 1;
    abortRef.current?.abort();
    const startupPending = busy && phase === 'idle';
    const coordinator = coordinatorRef.current;
    coordinatorRef.current = null;
    setBusy(true);
    try {
      await coordinator?.cancel();
      setPreviews([]);
      setSourceName(null);
      setProgress(null);
      setError(null);
      updatePhase('idle');
      if (coordinator || startupPending) {
        restartAfterPortableBackup(ROUTES.default());
      } else {
        onBack();
      }
    } catch {
      coordinatorRef.current = coordinator;
      setPreviews([]);
      updatePhase('cleanup');
      setError(t('import.cleanup_failed'));
    } finally {
      setBusy(false);
    }
  }, [busy, onBack, phase, t, updatePhase]);

  const install = useCallback(async () => {
    const coordinator = coordinatorRef.current;
    if (!coordinator || previews.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    setInstallAttempted(true);
    updatePhase('installing');
    let finishInstallLifecycle!: () => void;
    installPromiseRef.current = new Promise<void>(resolve => {
      finishInstallLifecycle = resolve;
    });
    let protectionAttempted = false;
    let nextPhase: Phase = 'confirm';
    let nextError: string | null = null;
    let terminalFailure = false;
    try {
      if (nativePlatform) {
        protectionAttempted = true;
        await startNativeImportProtection({
          notificationTitle: t('import.notification_title'),
          preparing: t('import.installing'),
          writing: t('import.installing'),
          verifying: t('import.installing'),
        });
        await updateNativeImportProtection(t('import.installing'));
      }
      markPortableImportCleanupPending();
      await blockPortableImportAccountOutputs();
      await coordinator.install();
      coordinatorRef.current = null;
      postCommitCleanupRef.current = true;
      try {
        await runPortableImportPostCommitCleanup();
        postCommitCleanupRef.current = false;
        nextPhase = 'success';
      } catch {
        nextPhase = 'cleanup';
        nextError = t('import.cleanup_failed');
      }
    } catch (caught) {
      if (
        caught instanceof Error &&
        caught.name === 'PortableImportTerminalError'
      ) {
        coordinatorRef.current = null;
        terminalFailure = true;
        nextPhase = 'restart';
        nextError = t('import.terminal_failed');
      } else {
        try {
          if (await sdk.wasPortableImportInstalled()) {
            await coordinator.finalizeAttestedInstallation();
            coordinatorRef.current = null;
            postCommitCleanupRef.current = true;
            try {
              await runPortableImportPostCommitCleanup();
              postCommitCleanupRef.current = false;
              nextPhase = 'success';
            } catch {
              nextPhase = 'cleanup';
              nextError = t('import.cleanup_failed');
            }
          } else {
            try {
              await unblockPortableImportAccountOutputs();
              clearPortableImportCleanupPending();
              nextError = t('import.install_failed');
            } catch {
              outputUnblockRef.current = true;
              nextPhase = 'cleanup';
              nextError = t('import.cleanup_failed');
            }
          }
        } catch {
          coordinatorRef.current = null;
          terminalFailure = true;
          nextPhase = 'restart';
          nextError = t('import.terminal_failed');
        }
      }
    } finally {
      if (protectionAttempted) {
        await stopNativeImportProtection().catch(() => {});
      }
      finishInstallLifecycle();
      installPromiseRef.current = null;
      if (mountedRef.current) {
        if (terminalFailure) {
          setPreviews([]);
          setSourceName(null);
          setInstallAttempted(false);
        }
        setError(nextError);
        updatePhase(nextPhase);
        setBusy(false);
      }
    }
  }, [busy, nativePlatform, previews.length, sdk, t, updatePhase]);

  const complete = useCallback(() => {
    useAppStore.getState().setIsInitialized(true);
    restartAfterPortableBackup(ROUTES.welcome());
  }, []);

  if (phase === 'restart') {
    return (
      <PageLayout contentClassName="px-6 py-8">
        <div className="app-max-w mx-auto min-h-full flex flex-col justify-center text-center gap-6">
          <AlertTriangle className="w-16 h-16 text-warning mx-auto" />
          <div className="space-y-2">
            <h1 className="text-2xl font-bold text-foreground">
              {t('import.retry_restart_title')}
            </h1>
            <p className="text-sm text-muted-foreground leading-relaxed">
              {error ?? t('import.terminal_failed')}
            </p>
          </div>
          <Button
            fullWidth
            onClick={() => restartAfterPortableBackup(ROUTES.default())}
          >
            {t('import.retry_restart')}
          </Button>
        </div>
      </PageLayout>
    );
  }

  if (phase === 'success') {
    return (
      <PageLayout contentClassName="px-6 py-8">
        <div className="app-max-w mx-auto min-h-full flex flex-col justify-center text-center gap-6">
          <CheckCircle className="w-16 h-16 text-success mx-auto" />
          <div className="space-y-2">
            <h1 className="text-2xl font-bold text-foreground">
              {t('import.success_title')}
            </h1>
            <p className="text-sm text-muted-foreground leading-relaxed">
              {t('import.success_body')}
            </p>
          </div>
          <Button fullWidth onClick={complete}>
            {t('import.continue_login')}
          </Button>
        </div>
      </PageLayout>
    );
  }

  return (
    <PageLayout
      header={
        <PageHeader
          title={t('import.title')}
          onBack={phase === 'installing' ? undefined : () => void cancel()}
        />
      }
      className="app-max-w mx-auto"
      contentClassName="px-5 py-5"
    >
      <div className="space-y-4 pb-6">
        <div className="rounded-2xl border border-warning/40 bg-warning/10 p-4 flex gap-3">
          <AlertTriangle className="w-5 h-5 text-warning shrink-0 mt-0.5" />
          <div className="space-y-1 text-sm leading-relaxed">
            <p className="font-semibold text-foreground">
              {t('import.replace_title')}
            </p>
            <p className="text-muted-foreground">{t('import.replace_body')}</p>
          </div>
        </div>

        <div className="rounded-2xl border border-border bg-card p-4 space-y-2 text-sm text-muted-foreground">
          <p>{t('import.password_notice')}</p>
          <p>{t('import.biometric_notice')}</p>
          <p>{t('import.possession_notice')}</p>
        </div>

        {error && (
          <div
            role="alert"
            className="rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
          >
            {error}
          </div>
        )}

        {phase === 'cleanup' && (
          <Button fullWidth disabled={busy} onClick={() => void cancel()}>
            {t('import.retry_cleanup')}
          </Button>
        )}

        {phase === 'idle' && (
          <div className="space-y-4">
            <div className="rounded-2xl border border-dashed border-border p-6 text-center space-y-3">
              <FileText className="w-10 h-10 text-primary mx-auto" />
              <p className="text-sm text-muted-foreground">
                {supported
                  ? t('import.choose_file_body')
                  : t('import.unsupported')}
              </p>
              <Button
                fullWidth
                disabled={!supported || busy}
                onClick={() => void selectAndValidate()}
              >
                <Upload className="w-4 h-4" />
                {t('import.choose_file')}
              </Button>
            </div>
          </div>
        )}

        {phase === 'reading' && progress && (
          <div className="rounded-2xl border border-border bg-card p-5 space-y-3">
            <div className="flex items-center gap-3">
              <Lock className="w-5 h-5 text-primary" />
              <div className="min-w-0">
                <p className="font-semibold text-foreground truncate">
                  {sourceName}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t('import.validating')}
                </p>
              </div>
            </div>
            <div className="h-2 rounded-full bg-muted overflow-hidden">
              <div
                className="h-full bg-primary transition-all"
                style={{
                  width: `${Math.min(100, (progress.readBytes / progress.totalBytes) * 100)}%`,
                }}
              />
            </div>
            <p className="text-xs text-muted-foreground text-right">
              {formatBytes(progress.readBytes)} /{' '}
              {formatBytes(progress.totalBytes)}
            </p>
          </div>
        )}

        {(phase === 'passwords' ||
          phase === 'confirm' ||
          phase === 'installing') && (
          <>
            {phase === 'passwords' && (
              <form
                autoComplete="off"
                className="rounded-2xl border border-border bg-card p-4 space-y-3"
                onSubmit={event => {
                  event.preventDefault();
                  void authenticate();
                }}
              >
                <h2 className="font-semibold text-foreground">
                  {t('import.load_account')}
                </h2>
                <p className="text-sm text-muted-foreground">
                  {t('import.load_account_body')}
                </p>
                <RoundedInput
                  type="password"
                  value={password}
                  onChange={event => setPassword(event.target.value)}
                  placeholder={t('import.password')}
                  disabled={busy || previews.length >= 3}
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  suppressPasswordManager
                />
                <Button
                  type="submit"
                  fullWidth
                  disabled={!password || busy || previews.length >= 3}
                >
                  {busy ? t('import.checking') : t('import.load')}
                </Button>
              </form>
            )}

            <div className="space-y-3">
              {previews.map(preview => (
                <div
                  key={preview.userId}
                  className="rounded-2xl border border-border bg-card p-4 flex items-center gap-3"
                >
                  <UserProfileAvatar
                    name={preview.avatar ?? preview.username}
                    size={12}
                    interactive={false}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-foreground truncate">
                      {preview.username}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t('import.created', {
                        date: new Date(
                          preview.createdAtMs
                        ).toLocaleDateString(),
                      })}
                    </p>
                  </div>
                  {phase === 'passwords' && (
                    <Button
                      ariaLabel={t('import.remove_account', {
                        name: preview.username,
                      })}
                      variant="ghost"
                      size="sm"
                      onClick={() => removePreview(preview)}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  )}
                </div>
              ))}
            </div>

            {phase === 'passwords' && previews.length > 0 && (
              <Button fullWidth onClick={() => updatePhase('confirm')}>
                {t('import.review')}
              </Button>
            )}

            {(phase === 'confirm' || phase === 'installing') && (
              <div className="rounded-2xl border border-warning/40 bg-warning/10 p-4 space-y-4">
                <div className="space-y-1">
                  <h2 className="font-semibold text-foreground">
                    {t('import.confirm_title')}
                  </h2>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    {t('import.confirm_body')}
                  </p>
                </div>
                <Button
                  fullWidth
                  variant="danger"
                  disabled={phase === 'installing' || busy}
                  onClick={() => void install()}
                >
                  {phase === 'installing'
                    ? t('import.installing')
                    : installAttempted
                      ? t('import.retry_install')
                      : t('import.confirm')}
                </Button>
                {phase === 'confirm' && !installAttempted && (
                  <Button
                    fullWidth
                    variant="ghost"
                    onClick={() => updatePhase('passwords')}
                  >
                    {t('import.back_accounts')}
                  </Button>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </PageLayout>
  );
};

export default PortableImport;
