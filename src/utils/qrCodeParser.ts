import { AppRoute } from '../constants/routes';
import { validateUserIdFormat } from '../../gossip-sdk/src/utils/validation';

// Matches a clean invite path like "/invite/<userId>" (no query/fragment)
const INVITE_REGEX = new RegExp(`^/${AppRoute.invite}/([^/#?\\s]+)$`, 'i');

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
  const trimmed = input.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith(`/${AppRoute.invite}`)) {
    return trimmed;
  }

  // Handle gossip:// protocol
  if (trimmed.startsWith('gossip://')) {
    // Remove protocol and normalize path (handle both gossip:///invite and gossip://invite)
    const path = trimmed.replace(/^gossip:\/\/+/, '/').split(/[?#]/)[0];
    if (path.startsWith(`/${AppRoute.invite}`)) {
      return path;
    }
    return null;
  }

  try {
    const { pathname } = new URL(trimmed);
    if (pathname.startsWith(`/${AppRoute.invite}`)) {
      return pathname;
    }
  } catch {
    // Invalid URL format, return null
    return null;
  }

  return null;
}
