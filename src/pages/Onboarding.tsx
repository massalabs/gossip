import React, { useEffect, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { useAppStore } from '../stores/appStore';
import { useAccountStore } from '../stores/accountStore';
import OnboardingFlow from '../components/OnboardingFlow';
import AccountCreation from '../components/account/AccountCreation';
import BackgroundSyncOnboarding from '../components/onboarding/BackgroundSyncOnboarding';
import ToSAcceptance from '../components/ToSAcceptance';
import { SECURE_STORAGE_ENABLED } from '../config/features';
import SecureOnboardingChoice from '../components/onboarding/SecureOnboardingChoice';
import PortableImport from './PortableImport';
import {
  claimOnboardingStorageMode,
  isOnboardingStorageCreationAuthorized,
  type OnboardingStorageModeLease,
} from '../services/portableImportAuthorization';
import { restartAfterPortableBackup } from '../services/portableBackup';
import { ROUTES } from '../constants/routes';

/**
 * Routes for onboarding flow (when no account exists)
 *
 * NOTE: This component uses component state (showSetup) instead of
 * URL-based routing. This means:
 * - Browser back/forward buttons won't step through the onboarding flow
 * - State is lost on page refresh
 * The rest of the app uses React Router for proper browser navigation support.
 * This is acceptable for a one-time onboarding experience
 */
export const Onboarding: React.FC = () => {
  // When secure storage is enabled, skip the slideshow and go straight
  // to the account creation form (`AccountCreation` resolves to
  // `SecureAccountCreation` under the same flag — see
  // `components/account/AccountCreation.tsx`).
  const authorizedAtMount = useRef(
    !SECURE_STORAGE_ENABLED ||
      useAppStore.getState().secureAccountCreationAllowed
  ).current;
  const creationModeLeaseRef = useRef<OnboardingStorageModeLease | null>(null);
  const mountedRef = useRef(true);
  const creationClaimGenerationRef = useRef(0);
  const creationOperationActiveRef = useRef(false);
  const releaseLeaseAfterOperationRef = useRef(false);
  const [showAccountCreation, setShowAccountCreation] = useState(false);
  const [showImport, setShowImport] = useState(false);
  // When non-null, finalizeOnboarding is running in the background and we
  // are showing the BackgroundSyncOnboarding screen on top so the user can
  // toggle the high-reliability mode while we wait.
  const [finalizingPromise, setFinalizingPromise] =
    useState<Promise<void> | null>(null);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      creationClaimGenerationRef.current += 1;
      if (creationOperationActiveRef.current) {
        releaseLeaseAfterOperationRef.current = true;
      } else {
        const lease = creationModeLeaseRef.current;
        creationModeLeaseRef.current = null;
        void lease?.release();
      }
    };
  }, []);
  const tosAccepted = useAppStore.use.tosAccepted();
  const setTosAccepted = useAppStore.use.setTosAccepted();

  if (!tosAccepted) {
    return <ToSAcceptance onAccept={() => setTosAccepted(true)} />;
  }

  if (!authorizedAtMount) return null;

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

    const releaseCreationMode = async () => {
      const lease = creationModeLeaseRef.current;
      creationModeLeaseRef.current = null;
      await lease?.release();
    };

    if (isAndroid && hasActiveSession) {
      setFinalizingPromise(
        useAccountStore
          .getState()
          .finalizeOnboarding()
          .then(() => useAppStore.getState().setIsInitialized(true))
          .then(releaseCreationMode)
      );
      return;
    }

    await useAccountStore.getState().finalizeOnboarding();
    useAppStore.getState().setIsInitialized(true);
    await releaseCreationMode();
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
    return <PortableImport onBack={() => setShowImport(false)} />;
  }

  if (showAccountCreation) {
    return (
      <AccountCreation
        onComplete={() => {
          void finalizeOnboarding();
        }}
        creationModeLease={creationModeLeaseRef.current ?? undefined}
        onCredentialOperationChange={active => {
          creationOperationActiveRef.current = active;
          if (!active && releaseLeaseAfterOperationRef.current) {
            releaseLeaseAfterOperationRef.current = false;
            const lease = creationModeLeaseRef.current;
            creationModeLeaseRef.current = null;
            void lease?.release();
          }
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
              const lease = creationModeLeaseRef.current;
              creationModeLeaseRef.current = null;
              await lease?.release();
              setShowAccountCreation(false);
            }
          })();
        }}
      />
    );
  }

  if (SECURE_STORAGE_ENABLED) {
    return (
      <SecureOnboardingChoice
        onCreate={() => {
          const generation = creationClaimGenerationRef.current + 1;
          creationClaimGenerationRef.current = generation;
          void claimOnboardingStorageMode('create').then(
            async lease => {
              if (
                !mountedRef.current ||
                creationClaimGenerationRef.current !== generation
              ) {
                await lease.release();
                return;
              }
              if (!isOnboardingStorageCreationAuthorized()) {
                await lease.release();
                restartAfterPortableBackup(ROUTES.default());
                return;
              }
              creationModeLeaseRef.current = lease;
              setShowAccountCreation(true);
            },
            () => {
              if (
                mountedRef.current &&
                creationClaimGenerationRef.current === generation
              ) {
                restartAfterPortableBackup(ROUTES.default());
              }
            }
          );
        }}
        onImport={() => {
          creationClaimGenerationRef.current += 1;
          setShowImport(true);
        }}
      />
    );
  }

  return <OnboardingFlow onComplete={() => setShowAccountCreation(true)} />;
};
