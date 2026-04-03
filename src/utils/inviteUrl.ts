import { Capacitor } from '@capacitor/core';
import { DEWEB_DEV_INVITE_DOMAIN } from '../constants/links';
import { AppRoute } from '../constants/routes';

/**
 * Returns the public HTTPS URL that should be shared everywhere.
 * This is the UNIVERSAL link that works on:
 *   • Native apps (via gossip:// fallback page)
 *   • PWA (opens directly)
 *   • Web (opens web version)
 *   • QR codes, SMS, email, social sharing
 */
function getGossipDomain(): string {
  // 1. Explicit env var → highest priority (staging, prod, native builds)
  const envUrl = import.meta.env.VITE_INVITE_DOMAIN;

  if (envUrl) return envUrl;

  if (Capacitor.isNativePlatform()) {
    return DEWEB_DEV_INVITE_DOMAIN;
  }

  const currentOrigin = window.location?.origin;
  if (currentOrigin) {
    return currentOrigin;
  }

  return DEWEB_DEV_INVITE_DOMAIN;
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
export function generateDeepLinkUrl(userId: string, name?: string): string {
  if (!userId?.trim()) {
    throw new Error('userId is required');
  }

  const base = getGossipDomain();
  const safeId = encodeURIComponent(userId.trim());

  let url = `${base}/${AppRoute.invite}/${safeId}`;
  if (name?.trim()) {
    url += `?name=${encodeURIComponent(name.trim())}`;
  }
  return url;
}

/**
 * Builds the in-app invite path used on the web (React Router) and for
 * {@link parseInvite}. Includes optional query string (e.g. `?name=`).
 *
 * Example: `/invite/gossip1abc?name=Alice`
 */
export function buildInvitePath(
  userId: string,
  query?: URLSearchParams | string
): string {
  if (!userId?.trim()) {
    throw new Error('userId is required');
  }

  const q =
    query === undefined
      ? ''
      : typeof query === 'string'
        ? query
        : query.toString();
  const suffix = q ? `?${q}` : '';

  return `/${AppRoute.invite}/${userId.trim()}${suffix}`;
}

/**
 * Converts a web invite path (`/invite/...`) to the native custom-scheme URL.
 */
export function toGossipInviteHref(invitePath: string): string {
  if (!invitePath.startsWith('/')) {
    throw new Error('invitePath must start with /');
  }
  return `gossip://${invitePath.slice(1)}`;
}
