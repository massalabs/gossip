import { logger } from './utils/logger.ts';
import './i18n';
import React, { useState, useEffect, useRef } from 'react';
import { BrowserRouter, useMatch } from 'react-router-dom';
import { useAccountStore } from './stores/accountStore';
import { useAppStore } from './stores/appStore';
import ErrorBoundary from './components/ui/ErrorBoundary.tsx';
// import PWABadge from './PWABadge.tsx';
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
import { useOnlineStore } from './stores/useOnlineStore.tsx';
import { useTheme } from './hooks/useTheme.ts';
import { useScreenshotProtection } from './hooks/useScreenshotProtection';
import { useAutoLock } from './hooks/useAutoLock';
import PageLayout from './components/ui/Layout/PageLayout.tsx';

const AppContent: React.FC = () => {
  const { isLoading, userProfile } = useAccountStore();
  const { isInitialized } = useAppStore();
  const [showImport, setShowImport] = useState(false);
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
  if (isLoading && !isInitialized && !userProfile && !initialLoadDone.current) {
    return <LoadingScreen />;
  }

  // For invite links, we bypass onboarding so the user lands on the invite page.
  //
  // Design note: If a user manually navigates to an invite URL before initialization completes,
  // the onboarding flow is skipped and the invite page is shown directly. This is to handle the
  // case where a user has the phone app and doesn't necessarily need to create an account on web or pwa.
  if (!isInitialized && !inviteMatch) {
    return (
      <PageLayout>
        <Onboarding
          showImport={showImport}
          onShowImportChange={setShowImport}
        />
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

function App() {
  const { initTheme } = useTheme();
  const { initOnlineStore } = useOnlineStore();
  useScreenshotProtection();
  useAutoLock();

  useEffect(() => {
    let cleanup: (() => void) | undefined;

    const initialize = async () => {
      const cleanupFn = await initTheme();
      cleanup = cleanupFn;
      await initOnlineStore();
    };

    void initialize();

    return () => {
      cleanup?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <BrowserRouter>
      <ErrorBoundary>
        <KeyboardAwareWrapper>
          <AppUrlListener />
          <AppContent />
          <DebugConsole />
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
