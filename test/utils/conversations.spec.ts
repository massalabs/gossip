import { describe, expect, it } from 'vitest';
import type { Contact, Discussion } from '@massalabs/gossip-sdk';
import { SELF_CONTACT_ID } from '@massalabs/gossip-sdk';
import {
  isAcceptedContact,
  isConversationRow,
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
});
