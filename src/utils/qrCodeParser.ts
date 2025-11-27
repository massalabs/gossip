import { isValidUserId } from './userId';

const INVITE_REGEX = /^\/invite\/([^/#?\s]+)$/i;

export interface ParsedInvite {
  userId: string;
}

export function parseInvite(input: string): ParsedInvite {
  const path = extractInvitePath(input);
  if (!path) {
    throw new Error('Invalid invite format');
  }

  const match = path.match(INVITE_REGEX);
  if (!match) {
    throw new Error('Invalid invite format');
  }

  const userId = decodeURIComponent(match[1]);

  if (!isValidUserId(userId)) {
    throw new Error(
      'Invalid user ID format — must be a valid gossip1... address'
    );
  }

  return {
    userId,
  };
}

/**
 * Extract the clean invite path from any URL format
 * Returns null only when nothing invite-related is found
 */
export function extractInvitePath(input: string): string | undefined {
  const i = input.trim();
  if (!i) return;

  if (i.startsWith('/invite/')) {
    return i;
  }

  // Handle gossip:// protocol
  if (i.startsWith('gossip://')) {
    return i.replace('gossip://', '/');
  }

  try {
    const { pathname } = new URL(i);
    if (pathname.startsWith('/invite/')) {
      return pathname;
    }
  } catch {
    return;
  }
}
