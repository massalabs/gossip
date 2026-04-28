/**
 * Runtime feature flags.
 */

/**
 * Use the encrypted storage backend instead of classic IDB/OPFS.
 * Enabled via `VITE_SECURE_STORAGE=true` in `.env.local`. Ignored in
 * production builds (see `main.tsx` — the bootstrap refuses to run
 * with a hardcoded password outside DEV).
 */
export const SECURE_STORAGE_ENABLED =
  import.meta.env.VITE_SECURE_STORAGE === 'true';

/**
 * Hardcoded password used by the dev secure storage bootstrap. Replaced
 * by the real user-supplied password in a later layer. Empty outside
 * DEV so that leaking this constant into a prod bundle is harmless.
 */
export const DEV_HARDCODED_PASSWORD = import.meta.env.DEV
  ? 'changeme-dev-only'
  : '';
