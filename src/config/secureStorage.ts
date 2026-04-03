/**
 * Build flag: after basic creation, run secure storage multi-slot step.
 * false/absent = basic only (single path to login).
 */
export const secureStorageEnabled =
  import.meta.env.VITE_SECURE_STORAGE === 'true';

/**
 * Maximum number of accounts that can be created during secure storage setup.
 * Includes the main account. Default: 5 (1 main + 4 additional).
 */
export const maxSecureAccounts = Number(
  import.meta.env.VITE_SECURE_STORAGE_MAX_ACCOUNTS ?? 5
);
