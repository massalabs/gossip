import React from 'react';
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { useAccountStore } from '../stores/accountStore';
import { useAppStore } from '../stores/appStore';
import Login from '../pages/Login';
import AccountCreation from '../components/account/AccountCreation';
import { UserProfile } from '../db';

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

  const handleOnCreateNewAccount = () => {
    onLoginErrorChange(null);
    navigate('/setup');
  };

  const handleOnComplete = () => {
    useAppStore.getState().setIsInitialized(true);
    navigate('/', { replace: true });
  };

  const handleOnBackFromSetup = async () => {
    const hasAny = await useAccountStore.getState().hasExistingAccount();
    if (hasAny) {
      navigate('/welcome');
    } else {
      useAppStore.getState().setIsInitialized(false);
    }
  };

  return (
    <Routes>
      <Route
        path="/welcome"
        element={
          <Login
            key="login-router"
            onCreateNewAccount={handleOnCreateNewAccount}
            onAccountSelected={handleAccountSelected}
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
            onComplete={handleOnComplete}
            onBack={handleOnBackFromSetup}
          />
        }
      />
      <Route path="/" element={<Navigate to="/welcome" replace />} />
      <Route path="*" element={<Navigate to="/welcome" replace />} />
    </Routes>
  );
};
