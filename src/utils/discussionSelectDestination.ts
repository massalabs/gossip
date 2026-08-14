import { SELF_CONTACT_ID } from '@massalabs/gossip-sdk';
import { ROUTES } from '../constants/routes';

export type DiscussionSelectNavState =
  | { forwardFromMessageIds: number[] }
  | { prefilledMessage: string };

export interface DiscussionSelectDestination {
  path: string;
  state?: DiscussionSelectNavState;
  clearPendingForwardIds: boolean;
  clearPendingSharedContent: boolean;
}

export function hasPendingDiscussionSelection(
  pendingForwardMessageIds: number[],
  pendingSharedContent: string | null
): boolean {
  return pendingForwardMessageIds.length > 0 || !!pendingSharedContent;
}

/**
 * Pure destination-routing decision for selecting a discussion from the list.
 * Pending forward IDs always take priority over pending shared content
 * (including empty-string shared content from Notes with empty `content`).
 */
export function resolveDiscussionSelectDestination(
  contactUserId: string,
  pendingForwardMessageIds: number[],
  pendingSharedContent: string | null
): DiscussionSelectDestination {
  const hasForward = pendingForwardMessageIds.length > 0;

  if (contactUserId === SELF_CONTACT_ID) {
    if (hasForward) {
      return {
        path: ROUTES.selfDiscussion(),
        state: { forwardFromMessageIds: pendingForwardMessageIds },
        clearPendingForwardIds: true,
        clearPendingSharedContent: true,
      };
    }
    return {
      path: ROUTES.selfDiscussion(),
      clearPendingForwardIds: false,
      clearPendingSharedContent: false,
    };
  }

  if (hasForward) {
    return {
      path: ROUTES.discussion({ userId: contactUserId }),
      state: { forwardFromMessageIds: pendingForwardMessageIds },
      clearPendingForwardIds: true,
      clearPendingSharedContent: true,
    };
  }

  if (pendingSharedContent) {
    return {
      path: ROUTES.discussion({ userId: contactUserId }),
      state: { prefilledMessage: pendingSharedContent },
      clearPendingForwardIds: false,
      clearPendingSharedContent: true,
    };
  }

  return {
    path: ROUTES.discussion({ userId: contactUserId }),
    clearPendingForwardIds: false,
    clearPendingSharedContent: false,
  };
}
