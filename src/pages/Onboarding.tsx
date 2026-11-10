import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../stores/appStore';
import { useAccountStore } from '../stores/accountStore';
import AccountCreation, {
  type AccountCreationMode,
} from '../components/account/AccountCreation';
import Welcome from '../components/onboarding/Welcome';
import RestoreChoice from '../components/onboarding/RestoreChoice';
import ToS from '../components/ToS';
import PageHeader from '../components/ui/PageHeader';
import PageLayout from '../components/ui/Layout/PageLayout';
import { SECURE_STORAGE_ENABLED } from '../config/features';
import PortableImport from './PortableImport';
import {
  claimOnboardingStorageMode,
  isOnboardingStorageCreationAuthorized,
  type OnboardingStorageModeLease,
} from '../services/portableImportAuthorization';
import { restartAfterPortableBackup } from '../services/portableBackup';
import { ROUTES } from '../constants/routes';

type View = 'welcome' | 'terms' | 'restore' | 'import';

/**
 * Onboarding flow (when no account exists): one welcome screen, then
 * straight into account creation or restore, or the advanced setup of
 * several deniable accounts. Everything that can wait
 * (username, biometrics for password accounts, notifications, background
 * sync, additional accounts) lives in Settings.
 *
 * NOTE: This component uses component state instead of
 * URL-based routing. This means:
 * - Browser back/forward buttons won't step through the onboarding flow
 * - State is lost on page refresh
 * The rest of the app uses React Router for proper browser navigation support.
 * This is acceptable for a one-time onboarding experience
 */
export const Onboarding: React.FC = () => {
  const { t } = useTranslation('onboarding');
  const authorizedAtMount = useRef(
    !SECURE_STORAGE_ENABLED ||
      useAppStore.getState().secureAccountCreationAllowed
  ).current;
  const creationModeLeaseRef = useRef<OnboardingStorageModeLease | null>(null);
  const mountedRef = useRef(true);
  const creationClaimGenerationRef = useRef(0);
  const creationOperationActiveRef = useRef(false);
  const releaseLeaseAfterOperationRef = useRef(false);
  // Non-null while account creation is shown: a brand-new identity
  // ('create'), one restored from its recovery phrase ('import'), or the
  // advanced setup of several deniable accounts ('multi').
  const [creationMode, setCreationMode] = useState<AccountCreationMode | null>(
    null
  );
  const [view, setView] = useState<View>('welcome');
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

  if (!authorizedAtMount) return null;

  // The terms are accepted by continuing past the welcome screen.
  const acceptTerms = () => useAppStore.getState().setTosAccepted(true);

  const releaseCreationMode = async () => {
    const lease = creationModeLeaseRef.current;
    creationModeLeaseRef.current = null;
    await lease?.release();
  };

  const finalizeOnboarding = async () => {
    // Secure storage: single-account creation already logged the user in
    // through the regular login path, so the session is fully wired; the
    // multi-account setup leaves every account locked and the user picks one
    // on the login screen. Classic
    // storage: patch the freshly-created session so it gets the polling +
    // lastSeen wiring that a cold-start login provides.
    if (!SECURE_STORAGE_ENABLED) {
      await useAccountStore.getState().finalizeOnboarding();
    }
    useAppStore.getState().setIsInitialized(true);
    await releaseCreationMode();
  };

  const startCreation = (mode: AccountCreationMode) => {
    acceptTerms();
    if (!SECURE_STORAGE_ENABLED) {
      setCreationMode(mode);
      return;
    }
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
        setCreationMode(mode);
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
  };

  if (creationMode) {
    return (
      <AccountCreation
        mode={creationMode}
        onComplete={() => finalizeOnboarding()}
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
              await releaseCreationMode();
              setCreationMode(null);
            }
          })();
        }}
      />
    );
  }

  if (view === 'import') {
    return <PortableImport onBack={() => setView('restore')} />;
  }

  if (view === 'restore') {
    return (
      <RestoreChoice
        onMnemonic={() => startCreation('import')}
        onBackupFile={() => {
          acceptTerms();
          creationClaimGenerationRef.current += 1;
          setView('import');
        }}
        onBack={() => setView('welcome')}
      />
    );
  }

  if (view === 'terms') {
    return (
      <PageLayout
        header={
          <PageHeader
            title={t('tos.title', 'Terms of Service')}
            onBack={() => setView('welcome')}
          />
        }
        className="app-max-w mx-auto"
        contentClassName="p-4 flex flex-col min-h-0"
      >
        <ToS hideTitle />
      </PageLayout>
    );
  }

  return (
    <Welcome
      onCreate={() => startCreation('create')}
      onCreateMultiple={
        SECURE_STORAGE_ENABLED ? () => startCreation('multi') : undefined
      }
      onRestore={SECURE_STORAGE_ENABLED ? () => setView('restore') : undefined}
      onShowTerms={() => setView('terms')}
    />
  );
};
