// Auto-generated from drizzle migrations — do not edit manually.
// Regenerate with: npm run db:generate

export interface EmbeddedMigration {
  idx: number;
  tag: string;
  when: number;
  digest: string;
  statements: string[];
}

export const MIGRATIONS: EmbeddedMigration[] = [
  {
    "idx": 0,
    "tag": "0000_nifty_molly_hayes",
    "when": 1730000000000,
    "digest": "fd923d7e049b0ea3c2d30f032f627914f907e2bd1ca717aec6d72bf5d7fa3870",
    "statements": [
      "CREATE TABLE `activeSeekers` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,\n\t`seeker` blob NOT NULL\n);",
      "CREATE INDEX `active_seekers_seeker_idx` ON `activeSeekers` (`seeker`);",
      "CREATE TABLE `announcementCursors` (\n\t`userId` text PRIMARY KEY NOT NULL,\n\t`counter` text NOT NULL\n);",
      "CREATE TABLE `contacts` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,\n\t`ownerUserId` text NOT NULL,\n\t`userId` text NOT NULL,\n\t`name` text NOT NULL,\n\t`avatar` text,\n\t`publicKeys` blob NOT NULL,\n\t`isOnline` integer NOT NULL,\n\t`lastSeen` integer NOT NULL,\n\t`createdAt` integer NOT NULL\n);",
      "CREATE INDEX `contacts_owner_user_idx` ON `contacts` (`ownerUserId`,`userId`);",
      "CREATE INDEX `contacts_owner_name_idx` ON `contacts` (`ownerUserId`,`name`);",
      "CREATE TABLE `discussions` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,\n\t`ownerUserId` text NOT NULL,\n\t`contactUserId` text NOT NULL,\n\t`weAccepted` integer DEFAULT false NOT NULL,\n\t`sendAnnouncement` text,\n\t`direction` text NOT NULL,\n\t`nextSeeker` blob,\n\t`initiationAnnouncement` blob,\n\t`announcementMessage` text,\n\t`lastSyncTimestamp` integer,\n\t`customName` text,\n\t`lastMessageId` integer,\n\t`lastMessageContent` text,\n\t`lastMessageTimestamp` integer,\n\t`unreadCount` integer DEFAULT 0 NOT NULL,\n\t`killedNextRetryAt` integer,\n\t`saturatedRetryAt` integer,\n\t`saturatedRetryDone` integer DEFAULT 0 NOT NULL,\n\t`createdAt` integer NOT NULL,\n\t`updatedAt` integer NOT NULL\n);",
      "CREATE UNIQUE INDEX `discussions_owner_contact_idx` ON `discussions` (`ownerUserId`,`contactUserId`);",
      "CREATE TABLE `messages` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,\n\t`ownerUserId` text NOT NULL,\n\t`contactUserId` text NOT NULL,\n\t`messageId` blob,\n\t`content` text NOT NULL,\n\t`serializedContent` blob,\n\t`type` text NOT NULL,\n\t`direction` text NOT NULL,\n\t`status` text NOT NULL,\n\t`timestamp` integer NOT NULL,\n\t`metadata` text,\n\t`seeker` blob,\n\t`replyTo` text,\n\t`forwardOf` text,\n\t`deleteOf` text,\n\t`encryptedMessage` blob,\n\t`whenToSend` integer\n);",
      "CREATE INDEX `messages_owner_contact_idx` ON `messages` (`ownerUserId`,`contactUserId`);",
      "CREATE INDEX `messages_owner_status_idx` ON `messages` (`ownerUserId`,`status`);",
      "CREATE INDEX `messages_owner_contact_status_idx` ON `messages` (`ownerUserId`,`contactUserId`,`status`);",
      "CREATE INDEX `messages_owner_seeker_idx` ON `messages` (`ownerUserId`,`seeker`);",
      "CREATE INDEX `messages_owner_contact_dir_idx` ON `messages` (`ownerUserId`,`contactUserId`,`direction`);",
      "CREATE INDEX `messages_owner_dir_status_idx` ON `messages` (`ownerUserId`,`direction`,`status`);",
      "CREATE INDEX `messages_timestamp_idx` ON `messages` (`timestamp`);",
      "CREATE INDEX `messages_owner_contact_msgid_idx` ON `messages` (`ownerUserId`,`contactUserId`,`messageId`);",
      "CREATE TABLE `pendingAnnouncements` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,\n\t`announcement` blob NOT NULL,\n\t`fetchedAt` integer NOT NULL,\n\t`counter` text\n);",
      "CREATE UNIQUE INDEX `pending_announcements_announcement_idx` ON `pendingAnnouncements` (`announcement`);",
      "CREATE INDEX `pending_announcements_fetchedAt_idx` ON `pendingAnnouncements` (`fetchedAt`);",
      "CREATE TABLE `pendingEncryptedMessages` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,\n\t`seeker` blob NOT NULL,\n\t`ciphertext` blob NOT NULL,\n\t`fetchedAt` integer NOT NULL\n);",
      "CREATE INDEX `pending_encrypted_seeker_idx` ON `pendingEncryptedMessages` (`seeker`);",
      "CREATE INDEX `pending_encrypted_fetchedAt_idx` ON `pendingEncryptedMessages` (`fetchedAt`);",
      "CREATE TABLE `userProfile` (\n\t`userId` text PRIMARY KEY NOT NULL,\n\t`username` text NOT NULL,\n\t`avatar` text,\n\t`bio` text,\n\t`status` text NOT NULL,\n\t`lastSeen` integer NOT NULL,\n\t`createdAt` integer NOT NULL,\n\t`updatedAt` integer NOT NULL,\n\t`lastPublicKeyPush` integer,\n\t`security` text NOT NULL,\n\t`session` blob NOT NULL\n);",
      "CREATE INDEX `userProfile_username_idx` ON `userProfile` (`username`);",
      "CREATE INDEX `userProfile_status_idx` ON `userProfile` (`status`);"
    ]
  },
  {
    "idx": 1,
    "tag": "0001_messages_edit_of",
    "when": 1740000000000,
    "digest": "87b19f5fd0c63b859811cb1d208f415eeca388738e93ffc5699c8dc28d6c4e20",
    "statements": [
      "ALTER TABLE `messages` ADD COLUMN `editOf` text;"
    ]
  },
  {
    "idx": 2,
    "tag": "0002_discussions_pinned",
    "when": 1741000000000,
    "digest": "11703d7e0abf570b470db911caba648ad0af396a81b11ff925f286d4f5ef41d5",
    "statements": [
      "ALTER TABLE `discussions` ADD COLUMN `pinned` integer NOT NULL DEFAULT 0;"
    ]
  },
  {
    "idx": 3,
    "tag": "0003_messages_reaction_of",
    "when": 1742000000000,
    "digest": "1a7e1bd05e8a6abedb8cde2e14748f130a423e64d50f39963eec5a187381f3e0",
    "statements": [
      "ALTER TABLE `messages` ADD COLUMN `reactionOf` text;"
    ]
  },
  {
    "idx": 4,
    "tag": "0004_discussions_retention",
    "when": 1743000000000,
    "digest": "5f8754e0ef047ce40e5c31916794a13bdf08f76c17f3d0119fbf055f2aa7bb62",
    "statements": [
      "ALTER TABLE `discussions` ADD COLUMN `messageRetentionDuration` integer;",
      "ALTER TABLE `discussions` ADD COLUMN `retentionPolicySetAt` integer;"
    ]
  },
  {
    "idx": 5,
    "tag": "0005_discussions_muted",
    "when": 1744000000000,
    "digest": "6228606f146c11964ce136331170760847db7908115bb06ace9b78044160564c",
    "statements": [
      "ALTER TABLE `discussions` ADD COLUMN `mutedNotifications` integer NOT NULL DEFAULT 0;"
    ]
  },
  {
    "idx": 6,
    "tag": "0006_odd_titania",
    "when": 1787602604377,
    "digest": "821d55b096de5046d368b8a50307dea1981fff62d1c22a4a69f8b4567784313b",
    "statements": [
      "CREATE TABLE `accountSettings` (\n\t`userId` text PRIMARY KEY NOT NULL,\n\t`formatVersion` integer DEFAULT 1 NOT NULL,\n\t`mnsEnabled` integer DEFAULT false NOT NULL,\n\t`defaultRetentionDuration` integer DEFAULT 2592000\n);"
    ]
  },
  {
    "idx": 7,
    "tag": "0007_odd_lenny_balinger",
    "when": 1787775880997,
    "digest": "b22c0168d66895a2490fd2d5a379bf54c24292c8dda14c380559f996dda42c28",
    "statements": [
      "CREATE TABLE `privateMigration` (\n\t`id` integer PRIMARY KEY NOT NULL,\n\t`formatVersion` integer DEFAULT 1 NOT NULL,\n\t`installationEpoch` text NOT NULL,\n\t`completedPhase` integer DEFAULT 0 NOT NULL\n);"
    ]
  }
];
