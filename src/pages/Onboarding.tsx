import React, { useState, useCallback } from 'react';
import { useAppStore } from '../stores/appStore';
import { useAccountStore } from '../stores/accountStore';
import OnboardingFlow from '../components/OnboardingFlow';
import AccountImport from '../components/account/AccountImport';
import AccountCreation from '../components/account/AccountCreation';
import SecureStorageSetup from '../components/account/SecureStorageSetup';
import type { SecureStorageSetupCredentials } from '../stores/secureStorageSetupContext';

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
export const Onboarding: React.FC = () => {
  const [showImport, setShowImport] = useState(false);
  const [showAccountCreation, setShowAccountCreation] = useState(false);
  const [secureStorageCreds, setSecureStorageCreds] =
    useState<SecureStorageSetupCredentials | null>(null);

  const handleAccountCreated = useCallback(
    (creds?: SecureStorageSetupCredentials) => {
      if (creds) {
        setSecureStorageCreds(creds);
      } else {
        useAppStore.getState().setIsInitialized(true);
      }
    },
    []
  );

  const handleAccountCreationBack = useCallback(() => {
    void (async () => {
      const hasAny = await useAccountStore.getState().hasExistingAccount();
      if (hasAny) {
        useAppStore.getState().setIsInitialized(true);
      } else {
        setShowAccountCreation(false);
      }
    })();
  }, []);

  if (showImport) {
    return (
      <AccountImport
        onBack={() => setShowImport(false)}
        onComplete={() => {
          useAppStore.getState().setIsInitialized(true);
        }}
      />
    );
  }

  if (secureStorageCreds) {
    return (
      <SecureStorageSetup
        mainCredentials={secureStorageCreds}
        onComplete={() => {
          setSecureStorageCreds(null);
          useAppStore.getState().setIsInitialized(true);
        }}
      />
    );
  }

  if (showAccountCreation) {
    return (
      <AccountCreation
        onComplete={handleAccountCreated}
        onBack={handleAccountCreationBack}
      />
    );
  }

  return (
    <OnboardingFlow
      onComplete={() => setShowAccountCreation(true)}
      onImportMnemonic={() => setShowImport(true)}
    />
  );
};
