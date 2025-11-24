import React, { useEffect, useState } from 'react';
import { HashRouter } from 'react-router-dom';
import { useAccountStore } from './stores/accountStore';
import { useAppStore } from './stores/appStore';
import ErrorBoundary from './components/ui/ErrorBoundary.tsx';
import PWABadge from './PWABadge.tsx';
import DebugOverlay from './components/ui/DebugOverlay.tsx';
import { addDebugLog } from './components/ui/debugLogs';
import { Toaster } from 'react-hot-toast';
import { PrivacyGraphic } from './components/ui/PrivacyGraphic';
import './App.css';

// Hooks
import { useProfileLoader } from './hooks/useProfileLoader';
import { useAppStateRefresh } from './hooks/useAppStateRefresh';
import { useAccountInfo } from './hooks/useAccountInfo';

// Route components
import { AuthenticatedRoutes } from './routes/AuthenticatedRoutes';
import { UnauthenticatedRoutes } from './routes/UnauthenticatedRoutes';
import { OnboardingRoutes } from './routes/OnboardingRoutes';
import { useMessageStore } from './stores/messageStore.tsx';
import { useDiscussionStore } from './stores/discussionStore.tsx';
import { useVersionCheck } from './hooks/useVersionCheck.ts';
import VersionUpdateModal from './components/ui/VersionUpdateModal.tsx';

const AppContent: React.FC = () => {
  const { isLoading, userProfile } = useAccountStore();
  const { isInitialized } = useAppStore();
  const initMessage = useMessageStore(s => s.init);
  const initDiscussion = useDiscussionStore(s => s.init);
  const [showImport, setShowImport] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  useProfileLoader();
  useAppStateRefresh();
  const existingAccountInfo = useAccountInfo();

  // Setup service worker: register, listen for messages, start sync scheduler, and initialize background sync
  // useEffect(() => {
  //   setupServiceWorker().catch(error => {
  //     console.error('Failed to setup service worker:', error);
  //   });
  // }, []); // Only run once on mount

  useEffect(() => {
    addDebugLog(
      `AppContent render: init=${isInitialized}, loading=${isLoading}, hasProfile=${!!userProfile}`
    );
  }, [isInitialized, isLoading, userProfile]);

  useEffect(() => {
    if (userProfile?.userId) {
      initMessage();
      initDiscussion();
    }
  }, [userProfile?.userId, initMessage, initDiscussion]);

  // Show global loader only during initial boot, not during sign-in.
  if (isLoading && !isInitialized && !userProfile) {
    return (
      <div className="bg-background flex items-center justify-center h-full">
        <div className="text-center">
          <PrivacyGraphic size={120} loading={true} />
          <p className="text-sm text-muted-foreground mt-4">Loading...</p>
        </div>
      </div>
    );
  }

  // If authenticated, show main app routes
  if (userProfile) {
    return <AuthenticatedRoutes />;
  }

  // If not initialized and no profile, show onboarding
  if (!isInitialized) {
    return (
      <OnboardingRoutes
        showImport={showImport}
        onShowImportChange={setShowImport}
      />
    );
  }

  // Initialized but unauthenticated: route between Login and Setup
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
    <HashRouter>
      <ErrorBoundary>
        <AppContent />
        <DebugOverlay />
        <div className="hidden">
          <PWABadge />
        </div>
        <Toaster
          position="top-center"
          toastOptions={{
            duration: 4000,
            style: {
              background: '#363636',
              color: '#fff',
            },
            success: {
              duration: 3000,
              iconTheme: {
                primary: '#4ade80',
                secondary: '#fff',
              },
            },
            error: {
              duration: 5000,
              iconTheme: {
                primary: '#ef4444',
                secondary: '#fff',
              },
            },
          }}
        />
        <VersionUpdateModal
          isOpen={showUpdatePrompt}
          onClose={dismissUpdate}
          onAccept={handleForceUpdate}
        />
      </ErrorBoundary>
    </HashRouter>
  );
}

export default App;
