import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '../stores/appStore';
import OnboardingFlow from '../components/OnboardingFlow';
import AccountImport from '../components/account/AccountImport';

/**
 * Routes for onboarding flow (when no account exists)
 *
 * NOTE: This component uses component state (showSetup, showImport) instead of
 * URL-based routing. This means:
 * - Browser back/forward buttons won't step through the onboarding flow
 * - State is lost on page refresh
 * The rest of the app uses React Router for proper browser navigation support.
 * This is acceptable for a one-time onboarding experience
 */
export const Onboarding: React.FC<{
  showImport: boolean;
  onShowImportChange: (show: boolean) => void;
}> = ({ showImport, onShowImportChange }) => {
  const navigate = useNavigate();

  if (showImport) {
    return (
      <AccountImport
        onBack={() => onShowImportChange(false)}
        onComplete={() => {
          useAppStore.getState().setIsInitialized(true);
        }}
      />
    );
  }

  return (
    <OnboardingFlow
      onComplete={() => {
        // Navigate first, then set state to avoid race condition
        // where component unmounts before navigation takes effect
        navigate('/setup');
        // Use requestAnimationFrame to ensure navigation is processed
        // before the state change causes Onboarding to unmount
        requestAnimationFrame(() => {
          useAppStore.getState().setIsInitialized(true);
        });
      }}
      onImportMnemonic={() => onShowImportChange(true)}
    />
  );
};
