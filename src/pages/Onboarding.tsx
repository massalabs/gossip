import React, { useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { useAppStore } from '../stores/appStore';
import { useAccountStore } from '../stores/accountStore';
import OnboardingFlow from '../components/OnboardingFlow';
import AccountImport from '../components/account/AccountImport';
import AccountCreation from '../components/account/AccountCreation';
import BackgroundSyncOnboarding from '../components/onboarding/BackgroundSyncOnboarding';
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
  // When non-null, finalizeOnboarding is running in the background and we
  // are showing the BackgroundSyncOnboarding screen on top so the user can
  // toggle the high-reliability mode while we wait.
  const [finalizingPromise, setFinalizingPromise] =
    useState<Promise<void> | null>(null);
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

  const finalizeOnboarding = async () => {
    // Patch the freshly-created session so it gets the polling + lastSeen
    // wiring that a cold-start login provides. On the multi-account path
    // (handleFinalize already logged out) this is a no-op and the user
    // lands on the login screen.
    //
    // Android single-account: run the finalize in the background and show
    // the BackgroundSyncOnboarding screen in parallel — that turns the
    // unavoidable wait into a useful UX moment where the user picks the
    // high-reliability sync mode. The BG sync screen awaits the same
    // promise before transitioning to the authenticated app.
    const hasActiveSession = useAccountStore.getState().userProfile !== null;
    const isAndroid = Capacitor.getPlatform() === 'android';

    if (isAndroid && hasActiveSession) {
      setFinalizingPromise(useAccountStore.getState().finalizeOnboarding());
      return;
    }

    await useAccountStore.getState().finalizeOnboarding();
    useAppStore.getState().setIsInitialized(true);
  };

  if (finalizingPromise) {
    return (
      <BackgroundSyncOnboarding
        finalizingPromise={finalizingPromise}
        onDone={() => {
          useAppStore.getState().setIsInitialized(true);
        }}
      />
    );
  }

  if (showImport) {
    return (
      <AccountImport
        onBack={() => onShowImportChange(false)}
        onComplete={() => {
          void finalizeOnboarding();
        }}
      />
    );
  }

  if (showAccountCreation) {
    return (
      <AccountCreation
        onComplete={() => {
          void finalizeOnboarding();
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
