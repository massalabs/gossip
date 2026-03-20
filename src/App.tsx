import './i18n';
import React, { useState, useEffect } from 'react';
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
import KeyboardAwareWrapper from './components/ui/KeyboardAwareWrapper';
import { ROUTES } from './constants/routes';
import { useAppInit } from './hooks/useAppInit';

const AppContent: React.FC = () => {
  useProfileLoader();
  useStoreInit(); // Initialize all stores when user profile is available

  const { isLoading, userProfile } = useAccountStore();
  const isInitialized = useAppStore(s => s.isInitialized);
  const existingAccountInfo = useAccountInfo();

  const [loginError, setLoginError] = useState<string | null>(null);

  const inviteMatch = useMatch(ROUTES.invite());
  const isOnboarding = !isInitialized && !inviteMatch;
  const isAuthenticated = !!userProfile;
  // Pending = initial profile load only. Guards against flashing Login/Onboarding
  // before useProfileLoader determines the correct state.
  // !isInitialized: once isInitialized is set (by useProfileLoader or secure storage setup),
  // isPending is permanently false — login attempts (loadAccount) won't unmount Login.
  const isPending = !isInitialized && isLoading && !userProfile;

  // Setup service worker: register, listen for messages, start sync scheduler, and initialize background sync
  useEffect(() => {
    setupServiceWorker().catch(error => {
      console.error('Failed to setup service worker:', error);
    });
  }, []); // Only run once on mount

  // Onboarding owns the full account-creation flow (including secure storage setup).
  // Must be checked before isPending: initializeAccount sets isLoading=true mid-flow,
  // and showing LoadingScreen would unmount Onboarding and lose its state.
  if (isOnboarding) {
    return <Onboarding />;
  }

  if (isPending) {
    return <LoadingScreen />;
  }

  if (isAuthenticated) {
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
  useAppInit();

  return (
    <BrowserRouter>
      <ErrorBoundary>
        <KeyboardAwareWrapper>
          <AppUrlListener />
          <AppContent />
          <DebugConsole />
        </KeyboardAwareWrapper>
        <Toaster position="top-center" toastOptions={toastOptions} />
      </ErrorBoundary>
    </BrowserRouter>
  );
}

export default App;
