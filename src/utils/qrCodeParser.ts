import { validateUserIdFormat } from './validation';

const INVITE_REGEX = /^\/invite\/([^/#?\s]+)$/i;

export interface ParsedInvite {
  userId: string;
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

  const userId = decodeURIComponent(match[1]);

  const result = validateUserIdFormat(userId);
  if (!result.valid) {
    throw new Error(result.error || 'Invalid user ID format');
  }

  return {
    userId,
  };
}

/**
 * Extract the clean invite path from any URL format
 * Returns null only when nothing invite-related is found
 */
export function extractInvitePath(input: string): string | null {
  const url = input.trim();
  if (!url) return null;

  if (url.startsWith('/invite/')) {
    return url;
  }

  try {
    const { pathname } = new URL(url);
    if (pathname.startsWith('/invite/')) {
      return pathname;
    }
  } catch {
    // Invalid URL format, return null
    return null;
  }

  return null;
}
