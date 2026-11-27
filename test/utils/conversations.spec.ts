import { describe, expect, it } from 'vitest';
import type { Contact, Discussion } from '@massalabs/gossip-sdk';
import { SELF_CONTACT_ID, SessionStatus } from '@massalabs/gossip-sdk';
import {
  isAcceptedContact,
  isConnectedNonContact,
  isConversationRow,
  isDisplayNameTaken,
  shownStatus,
} from '../../src/utils/conversations';

const discussion = (patch: Partial<Discussion> = {}): Discussion =>
  ({
    contactUserId: 'alice',
    isArchive: true,
    archived: false,
    linkedGroupId: null,
    directChatOwed: false,
    ...patch,
  }) as Discussion;
const contact = (patch: Partial<Contact> = {}): Contact =>
  ({ userId: 'alice', name: 'Alice', ...patch }) as Contact;

describe('conversation rows (§5.12)', () => {
  it('shows an archive not continued by a direct chat held here', () => {
    expect(isConversationRow(discussion(), contact(), new Set())).toBe(true);
    // Linked to a group no longer held: shown again.
    expect(
      isConversationRow(
        discussion({ linkedGroupId: 'g1' }),
        contact(),
        new Set(['g2'])
      )
    ).toBe(true);
  });

  it('shows a discussion continued by a held direct chat through that group', () => {
    expect(
      isConversationRow(
        discussion({ linkedGroupId: 'g1' }),
        contact(),
        new Set(['g1'])
      )
    ).toBe(false);
  });

  it('never shows an automatic connection, and always the note to self', () => {
    const auto = contact({ connection: 'automatic' });
    expect(isConversationRow(discussion(), auto, new Set())).toBe(false);
    expect(isAcceptedContact(auto)).toBe(false);
    expect(isAcceptedContact(contact())).toBe(true);
    expect(
      isConversationRow(
        discussion({ contactUserId: SELF_CONTACT_ID }),
        undefined,
        new Set()
      )
    ).toBe(true);
  });

  it('shows the request of a member of a shared chat as a request, never as a contact', () => {
    const requested = contact({ connection: 'requested' });
    expect(isConversationRow(discussion(), requested, new Set())).toBe(true);
    expect(isAcceptedContact(requested)).toBe(false);
    expect(shownStatus(SessionStatus.Active, requested)).toBe(
      SessionStatus.PeerRequested
    );
    expect(shownStatus(SessionStatus.Active, contact())).toBe(
      SessionStatus.Active
    );
    expect(
      shownStatus(SessionStatus.Active, contact({ connection: 'automatic' }))
    ).toBe(SessionStatus.Active);
  });

  it('tells a member of a shared chat who is no contact from a contact', () => {
    expect(isConnectedNonContact(contact({ connection: 'automatic' }))).toBe(
      true
    );
    expect(isConnectedNonContact(contact({ connection: 'requested' }))).toBe(
      true
    );
    expect(isConnectedNonContact(contact({ connection: 'accepted' }))).toBe(
      false
    );
    expect(isConnectedNonContact(contact())).toBe(false);
    expect(isConnectedNonContact(undefined)).toBe(false);
  });

  it('treats a member added on this device only as a contact of the user, listed in the conversations', () => {
    const added = contact({ connection: 'added' });
    expect(isAcceptedContact(added)).toBe(true);
    expect(isConnectedNonContact(added)).toBe(false);
    expect(
      isConversationRow(discussion({ isArchive: false }), added, new Set())
    ).toBe(true);
  });

  it('takes a display name used by another contact, whatever its case', () => {
    const list = [
      contact({ userId: 'alice', name: 'Alice' }),
      contact({ userId: 'bob', name: 'Bob' }),
    ];
    expect(isDisplayNameTaken(list, ' alice ')).toBe(true);
    expect(isDisplayNameTaken(list, 'Carol')).toBe(false);
    // The person being named keeps a name it already has.
    expect(isDisplayNameTaken(list, 'Bob', 'bob')).toBe(false);
  });
});
