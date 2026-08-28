import { describe, it, expect } from 'vitest';
import { SELF_CONTACT_ID } from '@massalabs/gossip-sdk';
import { ROUTES } from '../../src/constants/routes';
import {
  hasPendingDiscussionSelection,
  resolveDiscussionSelectDestination,
} from '../../src/utils/discussionSelectDestination';

describe('resolveDiscussionSelectDestination', () => {
  const contactUserId = 'contact-user-id';

  it('prioritizes pendingForwardMessageIds over empty pendingSharedContent', () => {
    const result = resolveDiscussionSelectDestination(contactUserId, [42], '');

    expect(result).toEqual({
      path: ROUTES.discussion({ userId: contactUserId }),
      state: { forwardFromMessageIds: [42] },
      clearPendingForwardIds: true,
      clearPendingSharedContent: true,
    });
  });

  it('uses prefilledMessage when only pendingSharedContent is set', () => {
    const result = resolveDiscussionSelectDestination(
      contactUserId,
      [],
      'shared text'
    );

    expect(result).toEqual({
      path: ROUTES.discussion({ userId: contactUserId }),
      state: { prefilledMessage: 'shared text' },
      clearPendingForwardIds: false,
      clearPendingSharedContent: true,
    });
  });

  it('navigates normally when neither pending forward nor shared content is active', () => {
    const result = resolveDiscussionSelectDestination(contactUserId, [], null);

    expect(result).toEqual({
      path: ROUTES.discussion({ userId: contactUserId }),
      clearPendingForwardIds: false,
      clearPendingSharedContent: false,
    });
  });

  it('routes Notes (SELF) with pending forward ids and clears both pending fields', () => {
    const result = resolveDiscussionSelectDestination(
      SELF_CONTACT_ID,
      [42],
      ''
    );

    expect(result).toEqual({
      path: ROUTES.selfDiscussion(),
      state: { forwardFromMessageIds: [42] },
      clearPendingForwardIds: true,
      clearPendingSharedContent: true,
    });
  });
});

describe('hasPendingDiscussionSelection', () => {
  it('stays active for forward-only messages with empty top-level content', () => {
    expect(hasPendingDiscussionSelection([42], '')).toBe(true);
  });

  it('is inactive when neither a forward nor shared content is pending', () => {
    expect(hasPendingDiscussionSelection([], null)).toBe(false);
    expect(hasPendingDiscussionSelection([], '')).toBe(false);
  });
});
