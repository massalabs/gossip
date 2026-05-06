import React from 'react';
import { Route, Navigate, useNavigate } from 'react-router-dom';
import { useAccountStore } from '../stores/accountStore';
import { useAppStore } from '../stores/appStore';
import Login from '../pages/Login';
import AccountCreation from '../components/account/AccountCreation';
import { InvitePage } from '../pages/InvitePage';
import { UserProfile } from '@massalabs/gossip-sdk';
import { ROUTES } from '../constants/routes';
import MainLayout from '../components/ui/Layout/MainLayout';
import AnimatedRoutes from '../components/ui/AnimatedRoutes';

interface UnauthenticatedRoutesProps {
  existingAccountInfo: UserProfile | null;
  loginError: string | null;
  onLoginErrorChange: (error: string | null) => void;
}

/**
 * Routes accessible when user is not authenticated.
 *
 * AnimatedRoutes provides cross-fade transitions between pages.
 * MainLayout automatically shows/hides bottom nav based on route.
 */
export const UnauthenticatedRoutes: React.FC<UnauthenticatedRoutesProps> = ({
  existingAccountInfo,
  loginError,
  onLoginErrorChange,
}) => {
  const navigate = useNavigate();

  const handleAccountSelected = () => {
    onLoginErrorChange(null);
  };

  const handleCreateNewAccount = () => {
    onLoginErrorChange(null);
    navigate(ROUTES.setup(), { replace: true });
  };

  const handleNewAccountComplete = () => {
    useAppStore.getState().setIsInitialized(true);
    navigate(ROUTES.default(), { replace: true });
  };

  const handleNewAccountBack = async () => {
    try {
      const hasAny = await useAccountStore.getState().hasExistingAccount();
      if (hasAny) {
        navigate(ROUTES.welcome());
      } else {
        useAppStore.getState().setIsInitialized(false);
      }
    } catch (error) {
      console.error('Failed to check existing accounts:', error);
      useAppStore.getState().setIsInitialized(false);
    }
  };

  return (
    <MainLayout>
      <AnimatedRoutes>
        <Route path={ROUTES.invite()} element={<InvitePage />} />
        <Route
          path={ROUTES.welcome()}
          element={
            <Login
              key="login-router"
              onCreateNewAccount={handleCreateNewAccount}
              onAccountSelected={handleAccountSelected}
              accountInfo={existingAccountInfo}
              persistentError={loginError}
              onErrorChange={onLoginErrorChange}
            />
          }
        />
        <Route
          path={ROUTES.setup()}
          element={
            <AccountCreation
              onComplete={handleNewAccountComplete}
              onBack={handleNewAccountBack}
            />
          }
        />
        <Route path="/" element={<Navigate to={ROUTES.welcome()} replace />} />
        <Route path="*" element={<Navigate to={ROUTES.welcome()} replace />} />
      </AnimatedRoutes>
    </MainLayout>
  );
};
