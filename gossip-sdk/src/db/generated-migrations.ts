// Auto-generated from drizzle migrations — do not edit manually.
// Regenerate with: npm run db:generate

export interface EmbeddedMigration {
  idx: number;
  tag: string;
  when: number;
  statements: string[];
}

export const MIGRATIONS: EmbeddedMigration[] = [
  {
    idx: 0,
    tag: '0000_nifty_molly_hayes',
    when: 1730000000000,
    statements: [
      'CREATE TABLE `activeSeekers` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,\n\t`seeker` blob NOT NULL\n);',
      'CREATE INDEX `active_seekers_seeker_idx` ON `activeSeekers` (`seeker`);',
      'CREATE TABLE `announcementCursors` (\n\t`userId` text PRIMARY KEY NOT NULL,\n\t`counter` text NOT NULL\n);',
      'CREATE TABLE `contacts` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,\n\t`ownerUserId` text NOT NULL,\n\t`userId` text NOT NULL,\n\t`name` text NOT NULL,\n\t`avatar` text,\n\t`publicKeys` blob NOT NULL,\n\t`isOnline` integer NOT NULL,\n\t`lastSeen` integer NOT NULL,\n\t`createdAt` integer NOT NULL\n);',
      'CREATE INDEX `contacts_owner_user_idx` ON `contacts` (`ownerUserId`,`userId`);',
      'CREATE INDEX `contacts_owner_name_idx` ON `contacts` (`ownerUserId`,`name`);',
      'CREATE TABLE `discussions` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,\n\t`ownerUserId` text NOT NULL,\n\t`contactUserId` text NOT NULL,\n\t`weAccepted` integer DEFAULT false NOT NULL,\n\t`sendAnnouncement` text,\n\t`direction` text NOT NULL,\n\t`nextSeeker` blob,\n\t`initiationAnnouncement` blob,\n\t`announcementMessage` text,\n\t`lastSyncTimestamp` integer,\n\t`customName` text,\n\t`lastMessageId` integer,\n\t`lastMessageContent` text,\n\t`lastMessageTimestamp` integer,\n\t`unreadCount` integer DEFAULT 0 NOT NULL,\n\t`killedNextRetryAt` integer,\n\t`saturatedRetryAt` integer,\n\t`saturatedRetryDone` integer DEFAULT 0 NOT NULL,\n\t`createdAt` integer NOT NULL,\n\t`updatedAt` integer NOT NULL\n);',
      'CREATE UNIQUE INDEX `discussions_owner_contact_idx` ON `discussions` (`ownerUserId`,`contactUserId`);',
      'CREATE TABLE `messages` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,\n\t`ownerUserId` text NOT NULL,\n\t`contactUserId` text NOT NULL,\n\t`messageId` blob,\n\t`content` text NOT NULL,\n\t`serializedContent` blob,\n\t`type` text NOT NULL,\n\t`direction` text NOT NULL,\n\t`status` text NOT NULL,\n\t`timestamp` integer NOT NULL,\n\t`metadata` text,\n\t`seeker` blob,\n\t`replyTo` text,\n\t`forwardOf` text,\n\t`deleteOf` text,\n\t`encryptedMessage` blob,\n\t`whenToSend` integer\n);',
      'CREATE INDEX `messages_owner_contact_idx` ON `messages` (`ownerUserId`,`contactUserId`);',
      'CREATE INDEX `messages_owner_status_idx` ON `messages` (`ownerUserId`,`status`);',
      'CREATE INDEX `messages_owner_contact_status_idx` ON `messages` (`ownerUserId`,`contactUserId`,`status`);',
      'CREATE INDEX `messages_owner_seeker_idx` ON `messages` (`ownerUserId`,`seeker`);',
      'CREATE INDEX `messages_owner_contact_dir_idx` ON `messages` (`ownerUserId`,`contactUserId`,`direction`);',
      'CREATE INDEX `messages_owner_dir_status_idx` ON `messages` (`ownerUserId`,`direction`,`status`);',
      'CREATE INDEX `messages_timestamp_idx` ON `messages` (`timestamp`);',
      'CREATE INDEX `messages_owner_contact_msgid_idx` ON `messages` (`ownerUserId`,`contactUserId`,`messageId`);',
      'CREATE TABLE `pendingAnnouncements` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,\n\t`announcement` blob NOT NULL,\n\t`fetchedAt` integer NOT NULL,\n\t`counter` text\n);',
      'CREATE UNIQUE INDEX `pending_announcements_announcement_idx` ON `pendingAnnouncements` (`announcement`);',
      'CREATE INDEX `pending_announcements_fetchedAt_idx` ON `pendingAnnouncements` (`fetchedAt`);',
      'CREATE TABLE `pendingEncryptedMessages` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,\n\t`seeker` blob NOT NULL,\n\t`ciphertext` blob NOT NULL,\n\t`fetchedAt` integer NOT NULL\n);',
      'CREATE INDEX `pending_encrypted_seeker_idx` ON `pendingEncryptedMessages` (`seeker`);',
      'CREATE INDEX `pending_encrypted_fetchedAt_idx` ON `pendingEncryptedMessages` (`fetchedAt`);',
      'CREATE TABLE `userProfile` (\n\t`userId` text PRIMARY KEY NOT NULL,\n\t`username` text NOT NULL,\n\t`avatar` text,\n\t`bio` text,\n\t`status` text NOT NULL,\n\t`lastSeen` integer NOT NULL,\n\t`createdAt` integer NOT NULL,\n\t`updatedAt` integer NOT NULL,\n\t`lastPublicKeyPush` integer,\n\t`security` text NOT NULL,\n\t`session` blob NOT NULL\n);',
      'CREATE INDEX `userProfile_username_idx` ON `userProfile` (`username`);',
      'CREATE INDEX `userProfile_status_idx` ON `userProfile` (`status`);',
    ],
  },
  {
    idx: 1,
    tag: '0001_messages_edit_of',
    when: 1740000000000,
    statements: ['ALTER TABLE `messages` ADD COLUMN `editOf` text;'],
  },
];
