/**
 * Build flag: after basic creation, run secure storage multi-slot step.
 * false/absent = basic only (single path to login).
 */
export const secureStorageEnabled =
  import.meta.env.VITE_SECURE_STORAGE === 'true';
