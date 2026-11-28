import React from 'react';
import { SECURE_STORAGE_ENABLED } from '../../config/features';
import SecureAccountCreation from './SecureAccountCreation';
import MultiAccountCreation from './MultiAccountCreation';
import ClassicAccountCreation from './ClassicAccountCreation';
import type { OnboardingStorageModeLease } from '../../services/portableImportAuthorization';

export type AccountCreationMode = 'create' | 'import' | 'multi';

interface AccountCreationProps {
  onComplete: () => void | Promise<void>;
  onBack: () => void;
  onCredentialOperationChange?: (active: boolean) => void;
  creationModeLease?: OnboardingStorageModeLease;
  /**
   * 'create': one new account in a single step (default).
   * 'import': one account restored from its recovery phrase.
   * 'multi': several deniable accounts set up together.
   */
  mode?: AccountCreationMode;
}

const AccountCreation: React.FC<AccountCreationProps> = ({
  mode = 'create',
  ...props
}) => {
  if (!SECURE_STORAGE_ENABLED) return <ClassicAccountCreation {...props} />;
  if (mode === 'multi') return <MultiAccountCreation {...props} />;
  return <SecureAccountCreation mode={mode} {...props} />;
};

export default AccountCreation;
