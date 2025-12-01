import React from 'react';
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { useAccountStore } from '../stores/accountStore';
import { useAppStore } from '../stores/appStore';
import Login from '../pages/Login';
import AccountCreation from '../components/account/AccountCreation';
import { InvitePage } from '../pages/InvitePage';
import { UserProfile } from '../db';
import { ROUTES } from '../constants/routes';

interface UnauthenticatedRoutesProps {
  existingAccountInfo: UserProfile | null;
  loginError: string | null;
  onLoginErrorChange: (error: string | null) => void;
}

/**
 * Routes accessible when user is not authenticated
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
    navigate(ROUTES.setup());
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
    <Routes>
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
    </Routes>
  );
};
