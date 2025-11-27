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
  const trimmed = input.trim();
  if (!trimmed) return undefined;

  if (trimmed.startsWith('/invite/')) {
    return trimmed;
  }

  // Handle gossip:// protocol
  if (trimmed.startsWith('gossip://')) {
    return trimmed.replace('gossip://', '/');
  }

  try {
    const { pathname } = new URL(trimmed);
    if (pathname.startsWith('/invite/')) {
      return pathname;
    }
  } catch {
    // Invalid URL format, return undefined
    return undefined;
  }
}
