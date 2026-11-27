/**
 * Which one-to-one discussions the conversation list shows (§2.1, §5.12).
 *
 * Every conversation is a group; a discussion is only a session with a peer.
 * The list shows a discussion as a row when it is an archive not yet
 * continued by a direct chat held here, a contact request, or a contact
 * with no chat yet (adding a contact starts none: either person starts it). A discussion whose direct chat is held is
 * shown through that group, and an automatic connection (a member of a group
 * who is no contact) is never a conversation.
 */
import { SELF_CONTACT_ID, SessionStatus } from '@massalabs/gossip-sdk';
import type {
  Contact,
  Discussion,
  GroupInvitation,
} from '@massalabs/gossip-sdk';

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

/**
 * Whether a contact is one the user accepted: not an automatic connection,
 * nor a member of a shared chat whose contact request waits. A member the
 * user added on this device only (`added`) is a contact for the user in
 * every list and choice; only what the peer can observe treats it as an
 * automatic connection, in the SDK (§5.12, D.91).
 */
export function isAcceptedContact(contact: Contact): boolean {
  return (
    contact.connection === undefined ||
    contact.connection === 'accepted' ||
    contact.connection === 'added'
  );
}

/**
 * Whether `contact` is a member of a shared chat who is no contact (§5.12):
 * a hidden automatic connection, or one whose contact request waits. Adding
 * such a person is local and sends nothing.
 */
export function isConnectedNonContact(
  contact: Contact | null | undefined
): boolean {
  return (
    contact?.connection === 'automatic' || contact?.connection === 'requested'
  );
}

/**
 * The status the lists show for a session (§5.12). The contact request of a
 * member of a shared chat waits for the user's answer while its connection
 * is open for the chat: it is shown as any request waiting.
 */
export function shownStatus(
  status: SessionStatus,
  contact: Contact | undefined
): SessionStatus {
  return contact?.connection === 'requested'
    ? SessionStatus.PeerRequested
    : status;
}

/**
 * Whether `name` is already the display name of a contact other than
 * `exceptUserId` (case-insensitive): the rule of the new-contact form.
 */
export function isDisplayNameTaken(
  contacts: readonly Contact[],
  name: string,
  exceptUserId?: string
): boolean {
  const n = name.trim().toLowerCase();
  return contacts.some(
    c => c.userId !== exceptUserId && c.name.toLowerCase() === n
  );
}

/**
 * Whether `invitation` is the invitation to the pair's chat (§5.12) that
 * `peer` started with `me`: a chat of two, with `migrate_from`, owned by
 * `peer`. While it waits, the contact's screen shows it instead of "Start a
 * chat", so that the second person accepts rather than starts another.
 */
export function isDirectChatInvitationFrom(
  invitation: GroupInvitation,
  peer: string,
  me: string | undefined
): boolean {
  return (
    invitation.owner === peer &&
    invitation.migrateFrom === 0 &&
    invitation.members.length === 2 &&
    !!me &&
    invitation.members.includes(me)
  );
}
