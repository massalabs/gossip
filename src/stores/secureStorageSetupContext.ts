/**
 * First-account context for the secure storage setup step (no password when alreadyCreated).
 */
export interface SecureStorageSetupCredentials {
  username: string;
  password?: string;
  useBiometrics?: boolean;
  iCloudSync?: boolean;
  alreadyCreated?: boolean;
}
