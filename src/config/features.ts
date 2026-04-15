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

/**
 * Maximum number of accounts that can be created during secure storage
 * setup. Includes the main account (1 main + 2 additional = 3 total).
 *
 * Hard-capped at 3 to match `SESSION_COUNT = 3` in the Rust crate
 * (`wasm/secure-storage/src/constants.rs`). Bumping the JS side without
 * also bumping the Rust constant produces a runtime "no slot available"
 * error — see `SPEC_DEVIATIONS.md` for the SESSION_COUNT rationale.
 */
export const MAX_SECURE_ACCOUNTS = Number(
  import.meta.env.VITE_SECURE_STORAGE_MAX_ACCOUNTS ?? 3
);
