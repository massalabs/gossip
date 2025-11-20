import React from 'react';
import {
  Routes,
  Route,
  Navigate,
  useNavigate,
  useParams,
} from 'react-router-dom';
import { Capacitor } from '@capacitor/core';
import { useAccountStore } from '../stores/accountStore';
import { useAppStore } from '../stores/appStore';
import Login from '../pages/Login';
import AccountCreation from '../components/account/AccountCreation';
import { UserProfile } from '../db';
import { setPendingDeepLink } from '../utils/deepLinkStorage';

interface UnauthenticatedRoutesProps {
  existingAccountInfo: UserProfile | null;
  loginError: string | null;
  onLoginErrorChange: (error: string | null) => void;
}

// Wrapper component to redirect to welcome with deep link info in URL params
const AddContactRedirectUnauth: React.FC = () => {
  const { userId } = useParams<{ userId: string }>();
  const navigate = useNavigate();
  const [searchParams] = React.useState(
    () => new URLSearchParams(window.location.search)
  );

  React.useEffect(() => {
    if (userId) {
      const name = searchParams.get('name');
      const deepLinkPath = `/add/${userId}${name ? `?name=${encodeURIComponent(name)}` : ''}`;

      // Clean up URL
      const newUrl = `${window.location.origin}${window.location.pathname.replace(/\/add\/.*$/, '') || '/'}`;
      window.history.replaceState(null, '', newUrl);

      // Store deep link and redirect to welcome
      if (Capacitor.isNativePlatform()) {
        // Use Capacitor Preferences for native (survives app kill)
        void setPendingDeepLink(deepLinkPath).then(() => {
          navigate('/welcome', { replace: true });
        });
      } else {
        // Use URL params for web (stateless) + store in Preferences as backup
        void setPendingDeepLink(deepLinkPath).then(() => {
          navigate(`/welcome?redirect=${encodeURIComponent(deepLinkPath)}`, {
            replace: true,
          });
        });
      }
    }
  }, [userId, navigate, searchParams]);

  return null;
};

/**
 * Routes accessible when user is not authenticated
 */
export const UnauthenticatedRoutes: React.FC<UnauthenticatedRoutesProps> = ({
  existingAccountInfo,
  loginError,
  onLoginErrorChange,
}) => {
  const navigate = useNavigate();

  return (
    <Routes>
      <Route
        path="/welcome"
        element={
          <Login
            key="login-router"
            onCreateNewAccount={() => {
              onLoginErrorChange(null); // Clear error when navigating to setup
              navigate('/setup');
            }}
            onAccountSelected={() => {
              // Only navigate if userProfile is actually set (successful login)
              // The route will automatically update when userProfile changes
              onLoginErrorChange(null); // Clear error on successful login
            }}
            accountInfo={existingAccountInfo}
            persistentError={loginError}
            onErrorChange={onLoginErrorChange}
          />
        }
      />
      <Route
        path="/setup"
        element={
          <AccountCreation
            onComplete={() => {
              useAppStore.getState().setIsInitialized(true);
              // After account creation, go to discussions
              navigate('/', { replace: true });
            }}
            onBack={() => {
              // If there is at least one account, go back to welcome; otherwise go to onboarding
              useAccountStore
                .getState()
                .hasExistingAccount()
                .then(hasAny => {
                  if (hasAny) {
                    navigate('/welcome');
                  } else {
                    useAppStore.getState().setIsInitialized(false);
                  }
                })
                .catch(() => {
                  // On error, fall back to onboarding
                  useAppStore.getState().setIsInitialized(false);
                });
            }}
          />
        }
      />
      {/* Deep link route for QR code scanning when not authenticated */}
      <Route path="/add/:userId" element={<AddContactRedirectUnauth />} />
      <Route path="/" element={<Navigate to="/welcome" replace />} />
      <Route path="*" element={<Navigate to="/welcome" replace />} />
    </Routes>
  );
};
