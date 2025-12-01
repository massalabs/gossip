import React, { useState, useEffect } from 'react';
import { BrowserRouter, useLocation } from 'react-router-dom';
import { useAccountStore } from './stores/accountStore';
import { useAppStore } from './stores/appStore';
import ErrorBoundary from './components/ui/ErrorBoundary.tsx';
// import PWABadge from './PWABadge.tsx';
import DebugOverlay from './components/ui/DebugOverlay.tsx';
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

const AppContent: React.FC = () => {
  const { isLoading, userProfile } = useAccountStore();
  const { isInitialized } = useAppStore();
  const [showImport, setShowImport] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const location = useLocation();

  useProfileLoader();

  const existingAccountInfo = useAccountInfo();

  // If the current URL is an invite link, we should respect it even when
  // there is no account yet, instead of forcing the onboarding flow.
  const inviteBasePath = ROUTES.invite().split('/:')[0]; // "/invite"
  const isInviteRoute = location.pathname.startsWith(inviteBasePath);

  // Setup service worker: register, listen for messages, start sync scheduler, and initialize background sync
  useEffect(() => {
    setupServiceWorker().catch(error => {
      console.error('Failed to setup service worker:', error);
    });
  }, []); // Only run once on mount

  if (isLoading && !isInitialized && !userProfile) {
    return <LoadingScreen />;
  }

  // When the app is not initialized and we're NOT on an invite link,
  // show the onboarding flow (no account exists yet).
  // For invite links, we bypass onboarding so the user lands on the invite page.
  if (!isInitialized && !isInviteRoute) {
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

  return (
    <BrowserRouter>
      <ErrorBoundary>
        <AppUrlListener />
        <AppContent />
        <DebugOverlay />
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
