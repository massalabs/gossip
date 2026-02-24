import type { DatabaseConnection } from '../sqlite';
import { ContactQueries } from './contacts';
import { DiscussionQueries } from './discussions';
import { MessageQueries } from './messages';
import { UserProfileQueries } from './userProfile';
import { AnnouncementCursorQueries } from './announcementCursors';
import { PendingAnnouncementQueries } from './pendingAnnouncements';
import { ActiveSeekerQueries } from './activeSeekers';

export type { ContactRow } from './contacts';
export type { DiscussionRow } from './discussions';
export type { MessageRow, MessageInsert } from './messages';
export type { UserProfileRow, UserProfileInsert } from './userProfile';
export { rowToUserProfile, userProfileToRow } from './userProfile';
export type { PendingAnnouncementRow } from './pendingAnnouncements';

/**
 * Bundle of all query classes, scoped to a single DatabaseConnection.
 *
 * Each GossipSdk instance creates its own Queries object, ensuring
 * all database access goes through the correct connection.
 */
export class Queries {
  readonly contacts: ContactQueries;
  readonly discussions: DiscussionQueries;
  readonly messages: MessageQueries;
  readonly userProfiles: UserProfileQueries;
  readonly announcementCursors: AnnouncementCursorQueries;
  readonly pendingAnnouncements: PendingAnnouncementQueries;
  readonly activeSeekers: ActiveSeekerQueries;

  constructor(readonly conn: DatabaseConnection) {
    this.contacts = new ContactQueries(conn);
    this.discussions = new DiscussionQueries(conn);
    this.messages = new MessageQueries(conn);
    this.userProfiles = new UserProfileQueries(conn);
    this.announcementCursors = new AnnouncementCursorQueries(conn);
    this.pendingAnnouncements = new PendingAnnouncementQueries(conn);
    this.activeSeekers = new ActiveSeekerQueries(conn);
  }
}
