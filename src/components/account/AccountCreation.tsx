import React, { useMemo } from 'react';
import AccountCreationFormView from './AccountCreationFormView';
import { useStorageMode } from '../../hooks/useStorageMode';
import type { SecureStorageSetupCredentials } from '../../stores/secureStorageSetupContext';
import {
  useAccountCreationForm,
  type AccountCreationCreatedContext,
} from '../../hooks/useAccountCreationForm';

export interface AccountCreationProps {
  onBack: () => void;
  /**
   * Called after account creation + flush.
   * - secure storage build: called with creds so parent can show SecureStorageSetup
   * - basic build: called without creds so parent sets initialized
   */
  onComplete: (creds?: SecureStorageSetupCredentials) => void;
}

/**
 * Account creation form. Delegates to parent via onComplete:
 * - secure storage: passes credentials for multi-slot setup
 * - basic: passes nothing, account is ready
 */
const AccountCreation: React.FC<AccountCreationProps> = ({
  onBack,
  onComplete,
}) => {
  const { secureStorageEnabled } = useStorageMode();
  const formOptions = useMemo(() => {
    if (secureStorageEnabled) {
      return {
        skipSetInitialized: true,
        onAccountCreated: (ctx: AccountCreationCreatedContext) => {
          onComplete({
            username: ctx.username,
            useBiometrics: ctx.useBiometrics,
            iCloudSync: ctx.iCloudSync,
            alreadyCreated: true,
          });
        },
      };
    }
    return {
      onAccountCreated: () => {
        onComplete();
      },
    };
  }, [onComplete, secureStorageEnabled]);

  const form = useAccountCreationForm(formOptions);

  return <AccountCreationFormView onBack={onBack} {...form} />;
};

export default AccountCreation;
