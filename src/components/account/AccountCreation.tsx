import { SECURE_STORAGE_ENABLED } from '../../config/features';
import SecureAccountCreation from './SecureAccountCreation';
import ClassicAccountCreation from './ClassicAccountCreation';

const AccountCreation = SECURE_STORAGE_ENABLED
  ? SecureAccountCreation
  : ClassicAccountCreation;

export default AccountCreation;
