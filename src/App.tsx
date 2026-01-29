import React, { useState, useEffect, useLayoutEffect } from 'react';
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
import { toastOptions } from './utils/toastOptions.ts';
import LoadingScreen from './components/ui/LoadingScreen.tsx';
import IOSKeyboardWrapper from './components/ui/IOSKeyboardWrapper';
import { ROUTES } from './constants/routes';
import { useOnlineStore } from './stores/useOnlineStore.tsx';
import { useTheme } from './hooks/useTheme.ts';
import { useScreenshotProtection } from './hooks/useScreenshotProtection';

const AppContent: React.FC = () => {
  const { isLoading, userProfile } = useAccountStore();
  const { isInitialized } = useAppStore();
  const [showImport, setShowImport] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  useProfileLoader();
  useStoreInit(); // Initialize all stores when user profile is available
  const existingAccountInfo = useAccountInfo();

  const inviteMatch = useMatch(ROUTES.invite());

  // Setup service worker: register, listen for messages, start sync scheduler, and initialize background sync
  useEffect(() => {
    setupServiceWorker().catch(error => {
      console.error('Failed to setup service worker:', error);
    });
  }, []); // Only run once on mount

  if (isLoading && !isInitialized && !userProfile) {
    return <LoadingScreen />;
  }

  // For invite links, we bypass onboarding so the user lands on the invite page.
  //
  // Design note: If a user manually navigates to an invite URL before initialization completes,
  // the onboarding flow is skipped and the invite page is shown directly. This is to handle the
  // case where a user has the phone app and doesn't necessarily need to create an account on web or pwa.
  if (!isInitialized && !inviteMatch) {
    return (
      <Onboarding showImport={showImport} onShowImportChange={setShowImport} />
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

  const [ready, setReady] = useState(false);

  useLayoutEffect(() => {
    // Safe area insets are captured in main.tsx before app renders
    // Here we just initialize theme and online store
    const init = async () => {
      await initTheme();
      await initOnlineStore();
      setReady(true);
    };

    init();
  }, [initTheme, initOnlineStore]);

  useEffect(() => {
    let cleanup: (() => void) | undefined;

    const initialize = async () => {
      const cleanupFn = await initTheme();
      cleanup = cleanupFn;
      await initOnlineStore();
    };

    void initialize();

    return () => {
      if (cleanup) {
        cleanup();
      }
    };
    // Note: initTheme and initOnlineStore are intentionally excluded from dependencies
    // as they are initialization functions that should only run once on mount.
    // Including them could cause unnecessary re-initialization.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!ready) {
    return <LoadingScreen />;
  }

  return (
    <BrowserRouter>
      <ErrorBoundary>
        <IOSKeyboardWrapper>
          <AppUrlListener />
          <AppContent />
          <DebugConsole />
          {/* <div className="hidden">
            <PWABadge />
          </div> */}
        </IOSKeyboardWrapper>
        <Toaster position="top-center" toastOptions={toastOptions} />
      </ErrorBoundary>
    </BrowserRouter>
  );
}

export default App;
