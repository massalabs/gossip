import { INVITE_BASE_URL } from './qrCodeUrl';

// Single regex – the source of truth
const INVITE_REGEX = /^\/invite\/([^/#?\s]+)(?:\/([^/#?\s]*))?/i;

export interface ParsedInvite {
  userId: string;
  name: string;
}

export function parseInvite(input: string): ParsedInvite {
  const path = extractInvitePath(input);

  if (!path) {
    throw new Error('Invalid or empty invite');
  }

  const match = path.match(INVITE_REGEX);
  if (!match) {
    throw new Error('Invalid invite format');
  }

  const [, userId, rawName] = match;

  return {
    userId: decodeURIComponent(userId),
    name: decodeURIComponent(rawName),
  };
}

/**
 * Extract the clean invite path from any URL format
 * Returns null only when nothing invite-related is found
 */
export function extractInvitePath(input: string): string | null {
  if (!input?.trim()) return null;

  const trimmed = input.trim();

  // Fast path – already a clean path
  if (trimmed.startsWith(`${INVITE_BASE_URL}/`)) {
    return trimmed.split(/[?#]/)[0];
  }

  try {
    const url = new URL(trimmed);

    // 1. Check pathname first (invite might be in pathname even if hash exists)
    const pathname = url.pathname.split(/[?#]/)[0];
    if (pathname.startsWith(`${INVITE_BASE_URL}/`)) {
      return pathname;
    }

    // 2. HashRouter → #/invite/…
    if (url.hash) {
      const hashPath = url.hash.slice(1).split(/[?#]/)[0];
      return hashPath.startsWith(`${INVITE_BASE_URL}/`) ? hashPath : null;
    }

    return null;
  } catch {
    // Fallback for broken/malformed URLs or custom schemes
    const hashMatch = trimmed.match(/#(\/invite\/[^?#\s]*)/i);
    if (hashMatch) return hashMatch[1];

    const pathMatch = trimmed.match(/(\/invite\/[^?#\s]*)/i);
    return pathMatch ? pathMatch[1] : null;
  }
}
