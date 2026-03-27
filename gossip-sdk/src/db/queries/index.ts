import type { DatabaseConnection } from '../sqlite.js';
import { ContactQueries } from './contacts.js';
import { DiscussionQueries } from './discussions.js';
import { DMQueries } from './DM.js';
import { MessageQueries } from './messages.js';
import { SessionQueries } from './session.js';
import { UserProfileQueries } from './userProfile.js';
import { AnnouncementCursorQueries } from './announcementCursors.js';
import { PendingAnnouncementQueries } from './pendingAnnouncements.js';
import { ActiveSeekerQueries } from './activeSeekers.js';

export type { ContactRow } from './contacts.js';
export type { DiscussionRow } from './discussions.js';
export type { DMRow, DMInsert } from './DM.js';
export type { MessageRow, MessageInsert } from './messages.js';
export type { SessionRow, SessionInsert } from './session.js';
export type { UserProfileRow, UserProfileInsert } from './userProfile.js';
export { rowToUserProfile, userProfileToRow } from './userProfile.js';
export type { PendingAnnouncementRow } from './pendingAnnouncements.js';

/**
 * Bundle of all query classes, scoped to a single DatabaseConnection.
 *
 * Each GossipSdk instance creates its own Queries object, ensuring
 * all database access goes through the correct connection.
 */
export class Queries {
  readonly contacts: ContactQueries;
  readonly discussions: DiscussionQueries;
  readonly dms: DMQueries;
  readonly messages: MessageQueries;
  readonly sessions: SessionQueries;
  readonly userProfiles: UserProfileQueries;
  readonly announcementCursors: AnnouncementCursorQueries;
  readonly pendingAnnouncements: PendingAnnouncementQueries;
  readonly activeSeekers: ActiveSeekerQueries;

  constructor(readonly conn: DatabaseConnection) {
    this.contacts = new ContactQueries(conn);
    this.discussions = new DiscussionQueries(conn);
    this.dms = new DMQueries(conn);
    this.messages = new MessageQueries(conn);
    this.sessions = new SessionQueries(conn);
    this.userProfiles = new UserProfileQueries(conn);
    this.announcementCursors = new AnnouncementCursorQueries(conn);
    this.pendingAnnouncements = new PendingAnnouncementQueries(conn);
    this.activeSeekers = new ActiveSeekerQueries(conn);
  }
}
