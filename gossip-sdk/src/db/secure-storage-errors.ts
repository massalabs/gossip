export const SECURE_STORAGE_RECOVERY_REQUIRED =
  '[secure-storage-recovery-required]';

export class SecureStorageRecoveryRequiredError extends Error {
  readonly originalCause: unknown;

  constructor(cause: unknown) {
    super(
      cause instanceof Error
        ? cause.message
        : 'Secure storage recovery is required'
    );
    this.name = 'SecureStorageRecoveryRequiredError';
    this.originalCause = cause;
  }
}

export function requiresSecureStorageRecovery(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes(SECURE_STORAGE_RECOVERY_REQUIRED)
  );
}
