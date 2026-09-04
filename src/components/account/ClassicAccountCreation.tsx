import React from 'react';
import { useAccountStore } from '../../stores/accountStore';
import AccountCreationForm, {
  AccountCreationResult,
} from './AccountCreationForm';
import type { OnboardingStorageModeLease } from '../../services/portableImportAuthorization';

interface ClassicAccountCreationProps {
  onComplete: () => void | Promise<void>;
  onBack: () => void;
  onCredentialOperationChange?: (active: boolean) => void;
  creationModeLease?: OnboardingStorageModeLease;
}

const ClassicAccountCreation: React.FC<ClassicAccountCreationProps> = ({
  onComplete,
  onBack,
}) => {
  const initializeAccount = useAccountStore(state => state.initializeAccount);

  const handleSubmit = async (result: AccountCreationResult) => {
    await initializeAccount(result.username, result.password);
    await onComplete();
  };

  return (
    <AccountCreationForm
      onSubmit={handleSubmit}
      onBack={onBack}
      standalone={true}
    />
  );
};

export default ClassicAccountCreation;
