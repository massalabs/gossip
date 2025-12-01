import { Capacitor } from '@capacitor/core';
import { DEFAULT_PUBLIC_BASE_URL } from '../constants/links';
import { AppRoute } from '../constants/routes';

export const INVITE_BASE_URL = '/invite';

/**
 * Returns the public HTTPS URL that should be shared everywhere.
 * This is the UNIVERSAL link that works on:
 *   • Native apps (via gossip:// fallback page)
 *   • PWA (opens directly)
 *   • Web (opens web version)
 *   • QR codes, SMS, email, social sharing
 */
function getPublicBaseUrl(): string {
  // 1. Explicit env var → highest priority (staging, prod, native builds)
  const envUrl = import.meta.env.VITE_APP_BASE_URL;

  const defaultBaseUrl = envUrl ?? DEFAULT_PUBLIC_BASE_URL;

  if (Capacitor.isNativePlatform()) {
    return defaultBaseUrl;
  }

  const currentOrigin = window.location?.origin;
  if (currentOrigin && !currentOrigin.includes('localhost')) {
    return currentOrigin;
  }

  return defaultBaseUrl;
}

/**
 * Generate the single, universal invite link you should share.
 * Example: https://gossip.app/invite/abc123xyz
 *
 * This link will:
 *   • Open the native app if installed (via gossip:// fallback)
 *   • Open the PWA if installed
 *   • Open the web app otherwise
 */
export function generateDeepLinkUrl(userId: string): string {
  if (!userId?.trim()) {
    throw new Error('userId is required');
  }

  const base = getPublicBaseUrl();
  const safeId = encodeURIComponent(userId.trim());

  return `${base}${AppRoute.invite}/${safeId}`;
}
