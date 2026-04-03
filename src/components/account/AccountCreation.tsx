import { secureStorageEnabled } from '../../config/secureStorage';
import SecureAccountCreation from './SecureAccountCreation';
import ClassicAccountCreation from './ClassicAccountCreation';

const AccountCreation = secureStorageEnabled
  ? SecureAccountCreation
  : ClassicAccountCreation;

export default AccountCreation;
