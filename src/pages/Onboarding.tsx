import React, { useState } from 'react';
import { useAppStore } from '../stores/appStore';
import { useAccountStore } from '../stores/accountStore';
import OnboardingFlow from '../components/OnboardingFlow';
import AccountImport from '../components/account/AccountImport';
import AccountCreation from '../components/account/AccountCreation';
import ToSAcceptance from '../components/ToSAcceptance';
import { getDevAccounts } from '../hooks/useDevAutoLogin';
import { SECURE_STORAGE_ENABLED } from '../config/features';

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
  // When secure storage is enabled, skip the slideshow and go straight
  // to the account creation form (`AccountCreation` resolves to
  // `SecureAccountCreation` under the same flag — see
  // `components/account/AccountCreation.tsx`).
  const [showAccountCreation, setShowAccountCreation] = useState(
    SECURE_STORAGE_ENABLED
  );
  const [skipDevPicker, setSkipDevPicker] = useState(false);
  const tosAccepted = useAppStore.use.tosAccepted();
  const setTosAccepted = useAppStore.use.setTosAccepted();

  if (!tosAccepted) {
    return <ToSAcceptance onAccept={() => setTosAccepted(true)} />;
  }

  // Dev mode: show account picker instead of onboarding
  const devAccounts = getDevAccounts();
  if (devAccounts.length > 0 && !skipDevPicker) {
    const DevAccountPicker = React.lazy(
      () => import('../components/dev/DevAccountPicker')
    );
    return (
      <React.Suspense fallback={null}>
        <DevAccountPicker
          accounts={devAccounts}
          onSkip={() => setSkipDevPicker(true)}
        />
      </React.Suspense>
    );
  }

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
            } else if (!SECURE_STORAGE_ENABLED) {
              // Otherwise go back to onboarding slideshow — but only
              // in the legacy path. Under secure storage the slideshow
              // was skipped on purpose; dropping back to it here would
              // contradict that decision, so we stay on the creation
              // form.
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
