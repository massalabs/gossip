/**
 * Full debug build (`VITE_FULL_DEBUG=true`, see `npm run build:full-debug`).
 *
 * This build records everything the app does, message content and keys
 * included, and can send the record to the developers. It breaks the
 * project's privacy rule on purpose and is for testers on fresh accounts
 * only. Every piece of it is behind this one constant, so that a normal
 * build drops it as dead code: the release audits check that no trace of it
 * is left (docs/PRIVACY-CHECKS.md).
 */
export const FULL_DEBUG = import.meta.env.VITE_FULL_DEBUG === 'true';
