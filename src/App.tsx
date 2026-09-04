import { logger } from './utils/logger.ts';
import './i18n';
import React, { useState, useEffect, useRef } from 'react';
import { BrowserRouter, useMatch } from 'react-router-dom';
import { useAccountStore } from './stores/accountStore';
import { useAppStore } from './stores/appStore';
import { reconcileDebugLogsGeneration } from './stores/useDebugLogs';
import ErrorBoundary from './components/ui/ErrorBoundary.tsx';
import { DebugConsole } from './components/ui/DebugConsole';
import { Toaster } from 'react-hot-toast';

// Hooks
import { useProfileLoader } from './hooks/useProfileLoader';
import { useAccountInfo } from './hooks/useAccountInfo';
import { useStoreInit } from './hooks/useStoreInit.ts';
import { setupServiceWorker } from './services/serviceWorkerSetup';

// Route components
import { AuthenticatedRoutes } from './routes/AuthenticatedRoutes';
import { UnauthenticatedRoutes } from './routes/UnauthenticatedRoutes';
import { Onboarding } from './pages/Onboarding.tsx';
import { AppUrlListener } from './components/AppUrlListener';
import { toastOptions, toasterContainerStyle } from './utils/toastOptions.ts';
import LoadingScreen from './components/ui/LoadingScreen.tsx';
import KeyboardAwareWrapper from './components/ui/KeyboardAwareWrapper';
import { ROUTES } from './constants/routes';
import { useOnlineStore } from './stores/useOnlineStore';
import { useTheme } from './hooks/useTheme.ts';
import { useScreenshotProtection } from './hooks/useScreenshotProtection';
import { useAutoLock } from './hooks/useAutoLock';
import PageLayout from './components/ui/Layout/PageLayout.tsx';
import PortableBackupStartupGate from './components/PortableBackupStartupGate.tsx';
import {
  isPortableImportCleanupPending,
  PORTABLE_IMPORT_CLEANUP_EVENT,
} from './services/portableImportCleanup';

export const AppContent: React.FC = () => {
  // Field selectors: subscribing to the whole store would re-render the
  // entire route tree on any account-store change.
  const isLoading = useAccountStore(s => s.isLoading);
  const userProfile = useAccountStore(s => s.userProfile);
  const isInitialized = useAppStore(s => s.isInitialized);
  const lockedStartupFallback = useAppStore(s => s.lockedStartupFallback);
  const routesInitialized = isInitialized || lockedStartupFallback;
  const [loginError, setLoginError] = useState<string | null>(null);
  useProfileLoader();
  useStoreInit(); // Initialize all stores when user profile is available
  const existingAccountInfo = useAccountInfo();

  const inviteMatch = useMatch(ROUTES.invite());

  // Track whether the initial profile-loader pass has settled. Without
  // this gate, ANY action that flips `isLoading=true` mid-flow (e.g.
  // `initializeAccount` during signup) would unmount the active screen
  // and swap to LoadingScreen — which then re-mounts the screen fresh
  // when isLoading flips back, dropping its internal step state. The
  // ref is only updated, never read in render directly, so we still
  // need a state to trigger the re-render after the initial load.
  const initialLoadDone = useRef(false);
  useEffect(() => {
    if (!isLoading && !initialLoadDone.current) {
      initialLoadDone.current = true;
    }
  }, [isLoading]);

  // Setup service worker: register, listen for messages, start sync scheduler, and initialize background sync
  useEffect(() => {
    setupServiceWorker().catch(error => {
      logger.error('Failed to setup service worker:', error);
    });
  }, []); // Only run once on mount

  // LoadingScreen only during the very first profile-loader pass — not
  // for subsequent actions that toggle isLoading (signup, login, etc.).
  if (
    isLoading &&
    !routesInitialized &&
    !userProfile &&
    !initialLoadDone.current
  ) {
    return <LoadingScreen />;
  }

  // For invite links, we bypass onboarding so the user lands on the invite page.
  //
  // Design note: If a user manually navigates to an invite URL before initialization completes,
  // the onboarding flow is skipped and the invite page is shown directly. This is to handle the
  // case where a user has the phone app and doesn't necessarily need to create an account on web or pwa.
  if (!routesInitialized && !inviteMatch) {
    return (
      <PageLayout>
        <Onboarding />
      </PageLayout>
    );
  }

  if (userProfile) {
    return <AuthenticatedRoutes />;
  }

  return (
    <UnauthenticatedRoutes
      existingAccountInfo={existingAccountInfo}
      loginError={loginError}
      onLoginErrorChange={setLoginError}
    />
  );
};

function CleanupGatedDebugConsole() {
  const [blocked, setBlocked] = useState(true);
  useEffect(() => {
    let active = true;
    let revision = 0;
    const refresh = async () => {
      const currentRevision = ++revision;
      const pending = isPortableImportCleanupPending();
      if (pending) {
        if (active) setBlocked(true);
        return;
      }
      await reconcileDebugLogsGeneration();
      if (
        active &&
        currentRevision === revision &&
        !isPortableImportCleanupPending()
      ) {
        setBlocked(false);
      }
    };
    const handleRefresh = () => void refresh();
    window.addEventListener(PORTABLE_IMPORT_CLEANUP_EVENT, handleRefresh);
    window.addEventListener('storage', handleRefresh);
    void refresh();
    return () => {
      active = false;
      window.removeEventListener(PORTABLE_IMPORT_CLEANUP_EVENT, handleRefresh);
      window.removeEventListener('storage', handleRefresh);
    };
  }, []);
  return blocked ? null : <DebugConsole />;
}

function App() {
  const { initTheme } = useTheme();
  const { initOnlineStore } = useOnlineStore();
  useScreenshotProtection();
  useAutoLock();

  useEffect(() => {
    let cleanup: (() => void) | undefined;
    let disposed = false;

    const initialize = async () => {
      const cleanupFn = await initTheme();
      // The effect may already be cleaned up (StrictMode first mount,
      // unmount during init) — dispose immediately instead of leaking the
      // theme listener.
      if (disposed) {
        cleanupFn?.();
        return;
      }
      cleanup = cleanupFn;
      await initOnlineStore();
    };

    void initialize();

    return () => {
      disposed = true;
      cleanup?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <BrowserRouter>
      <ErrorBoundary>
        <KeyboardAwareWrapper>
          <AppUrlListener />
          <PortableBackupStartupGate>
            <AppContent />
            <CleanupGatedDebugConsole />
          </PortableBackupStartupGate>
          {/* <div className="hidden">
            <PWABadge />
          </div> */}
        </KeyboardAwareWrapper>
        <Toaster
          position="top-center"
          containerStyle={toasterContainerStyle}
          toastOptions={toastOptions}
        />
      </ErrorBoundary>
    </BrowserRouter>
  );
}

export default App;
