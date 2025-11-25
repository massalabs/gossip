import React, { useState } from 'react';
import { useAppStore } from '../stores/appStore';
import { useAccountStore } from '../stores/accountStore';
import OnboardingFlow from '../components/OnboardingFlow';
import AccountImport from '../components/account/AccountImport';
import AccountCreation from '../components/account/AccountCreation';

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
  const [showAccountCreation, setShowAccountCreation] = useState(false);

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

  if (showAccountCreation) {
    return (
      <AccountCreation
        onComplete={() => {
          useAppStore.getState().setIsInitialized(true);
        }}
        onBack={() => {
          void (async () => {
            // Check if there are any existing accounts
            const hasAny = await useAccountStore
              .getState()
              .hasExistingAccount();
            if (hasAny) {
              // If accounts exist, go to login flow
              useAppStore.getState().setIsInitialized(true);
            } else {
              // Otherwise go back to onboarding
              setShowAccountCreation(false);
            }
          })();
        }}
      />
    );
  }

  return (
    <OnboardingFlow
      onComplete={() => setShowAccountCreation(true)}
      onImportMnemonic={() => onShowImportChange(true)}
    />
  );
};
