/**
 * Which one-to-one discussions the conversation list shows (§2.1, §5.12).
 *
 * Every conversation is a group; a discussion is only a session with a peer.
 * The list shows a discussion as a row when it is an archive not yet
 * continued by a direct chat held here, a contact request, or a new contact
 * whose chat is not founded yet. A discussion whose direct chat is held is
 * shown through that group, and an automatic connection (a member of a group
 * who is no contact) is never a conversation.
 */
import { SELF_CONTACT_ID } from '@massalabs/gossip-sdk';
import type { Contact, Discussion } from '@massalabs/gossip-sdk';

export function isConversationRow(
  discussion: Discussion,
  contact: Contact | undefined,
  heldGroups: ReadonlySet<string>
): boolean {
  if (discussion.contactUserId === SELF_CONTACT_ID) return true;
  if (contact?.connection === 'automatic') return false;
  return !(
    discussion.linkedGroupId !== null &&
    discussion.linkedGroupId !== undefined &&
    heldGroups.has(discussion.linkedGroupId)
  );
}

/** Whether a contact is one the user accepted (not an automatic connection). */
export function isAcceptedContact(contact: Contact): boolean {
  return contact.connection !== 'automatic';
}
