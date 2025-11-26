export const INVITE_BASE_URL = '/invite';

/**
 * Returns the correct public base URL for deep links / QR codes
 *
 * Priority:
 * 1. VITE_APP_BASE_URL (set in .env → perfect for staging/prod native builds)
 * 2. Current window.location.origin (web dev + production)
 * 3. Hardcoded fallback (never fails)
 */
function getBaseUrl(): string {
  // 1. Environment variable — highest priority (used in Capacitor builds, staging, etc.)
  const envUrl = import.meta.env.VITE_APP_BASE_URL?.trim();
  if (envUrl) {
    // Ensure no trailing slash
    return envUrl.endsWith('/') ? envUrl.slice(0, -1) : envUrl;
  }

  // 2. Web runtime — use current origin (works perfectly in browser)
  if (typeof window !== 'undefined' && window.location?.origin) {
    return window.location.origin;
  }

  // 3. Final fallback — your production domain
  return 'https://gossip.app';
}

/**
 * Generate a clean, shareable invite deep link that can be used in QR codes or direct sharing.
 * Format: https://gossip.app/invite/{userId}
 */
export function generateDeepLinkUrl(userId: string): string {
  if (!userId?.trim()) {
    throw new Error('userId is required');
  }

  const base = getBaseUrl();
  const safeId = encodeURIComponent(userId.trim());

  return `${base}${INVITE_BASE_URL}/${safeId}`;
}
