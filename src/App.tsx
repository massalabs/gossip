import React, { useState, useEffect } from 'react';
import { BrowserRouter, useMatch } from 'react-router-dom';
import { useAccountStore } from './stores/accountStore';
import { useAppStore } from './stores/appStore';
import ErrorBoundary from './components/ui/ErrorBoundary.tsx';
// import PWABadge from './PWABadge.tsx';
import { DebugConsole } from './components/ui/DebugConsole';
import { Toaster } from 'react-hot-toast';
import './App.css';

// Hooks
import { useProfileLoader } from './hooks/useProfileLoader';
import { useAccountInfo } from './hooks/useAccountInfo';
import { setupServiceWorker } from './services/serviceWorkerSetup';

// Route components
import { AuthenticatedRoutes } from './routes/AuthenticatedRoutes';
import { UnauthenticatedRoutes } from './routes/UnauthenticatedRoutes';
import { Onboarding } from './pages/Onboarding.tsx';
import { useVersionCheck } from './hooks/useVersionCheck.ts';
import VersionUpdateModal from './components/ui/VersionUpdateModal.tsx';
import { AppUrlListener } from './components/AppUrlListener';
import { toastOptions } from './utils/toastOptions.ts';
import LoadingScreen from './components/ui/LoadingScreen.tsx';
import { ROUTES } from './constants/routes';
import { useOnlineStore } from './stores/useOnlineStore.tsx';
import { useTheme } from './hooks/useTheme.ts';

const AppContent: React.FC = () => {
  const { isLoading, userProfile } = useAccountStore();
  const { isInitialized } = useAppStore();
  const [showImport, setShowImport] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  useProfileLoader();

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
  const { showUpdatePrompt, handleForceUpdate, dismissUpdate } =
    useVersionCheck();

  const { initTheme } = useTheme();
  const { initOnlineStore } = useOnlineStore();

  useEffect(() => {
    void initTheme();
    void initOnlineStore();
  }, [initTheme, initOnlineStore]);

  return (
    <BrowserRouter>
      <ErrorBoundary>
        <AppUrlListener />
        <AppContent />
        <DebugConsole />
        {/* <div className="hidden">
          <PWABadge />
        </div> */}
        <Toaster position="top-center" toastOptions={toastOptions} />
        <VersionUpdateModal
          isOpen={showUpdatePrompt}
          onClose={dismissUpdate}
          onAccept={handleForceUpdate}
        />
      </ErrorBoundary>
    </BrowserRouter>
  );
}

export default App;
