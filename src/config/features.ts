/**
 * Runtime feature flags.
 */

/**
 * Use the encrypted storage backend instead of classic IDB/OPFS.
 * Enabled via `VITE_SECURE_STORAGE=true` in `.env.local`.
 */
export const SECURE_STORAGE_ENABLED =
  import.meta.env.VITE_SECURE_STORAGE === 'true';

/**
 * Hardcoded password used by the dev secure storage bootstrap.
 * Replaced by the real user-supplied password in a later layer.
 */
export const DEV_HARDCODED_PASSWORD = 'changeme-dev-only';
