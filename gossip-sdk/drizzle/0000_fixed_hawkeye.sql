CREATE TABLE `activeSeekers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`seeker` blob NOT NULL
);
--> statement-breakpoint
CREATE INDEX `active_seekers_seeker_idx` ON `activeSeekers` (`seeker`);--> statement-breakpoint
CREATE TABLE `announcementCursors` (
	`userId` text PRIMARY KEY NOT NULL,
	`counter` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `contacts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ownerUserId` text NOT NULL,
	`userId` text NOT NULL,
	`name` text NOT NULL,
	`avatar` text,
	`publicKeys` blob NOT NULL,
	`isOnline` integer NOT NULL,
	`lastSeen` integer NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `contacts_owner_user_idx` ON `contacts` (`ownerUserId`,`userId`);--> statement-breakpoint
CREATE INDEX `contacts_owner_name_idx` ON `contacts` (`ownerUserId`,`name`);--> statement-breakpoint
CREATE TABLE `discussions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ownerUserId` text NOT NULL,
	`contactUserId` text NOT NULL,
	`weAccepted` integer DEFAULT false NOT NULL,
	`sendAnnouncement` text,
	`direction` text NOT NULL,
	`nextSeeker` blob,
	`initiationAnnouncement` blob,
	`announcementMessage` text,
	`lastSyncTimestamp` integer,
	`customName` text,
	`lastMessageId` integer,
	`lastMessageContent` text,
	`lastMessageTimestamp` integer,
	`unreadCount` integer DEFAULT 0 NOT NULL,
	`killedNextRetryAt` integer,
	`saturatedRetryAt` integer,
	`saturatedRetryDone` integer DEFAULT false NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `discussions_owner_contact_idx` ON `discussions` (`ownerUserId`,`contactUserId`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ownerUserId` text NOT NULL,
	`contactUserId` text NOT NULL,
	`messageId` blob,
	`content` text NOT NULL,
	`serializedContent` blob,
	`type` text NOT NULL,
	`direction` text NOT NULL,
	`status` text NOT NULL,
	`timestamp` integer NOT NULL,
	`metadata` text,
	`seeker` blob,
	`replyTo` text,
	`forwardOf` text,
	`deleteOf` text,
	`encryptedMessage` blob,
	`whenToSend` integer
);
--> statement-breakpoint
CREATE INDEX `messages_owner_contact_idx` ON `messages` (`ownerUserId`,`contactUserId`);--> statement-breakpoint
CREATE INDEX `messages_owner_status_idx` ON `messages` (`ownerUserId`,`status`);--> statement-breakpoint
CREATE INDEX `messages_owner_contact_status_idx` ON `messages` (`ownerUserId`,`contactUserId`,`status`);--> statement-breakpoint
CREATE INDEX `messages_owner_seeker_idx` ON `messages` (`ownerUserId`,`seeker`);--> statement-breakpoint
CREATE INDEX `messages_owner_contact_dir_idx` ON `messages` (`ownerUserId`,`contactUserId`,`direction`);--> statement-breakpoint
CREATE INDEX `messages_owner_dir_status_idx` ON `messages` (`ownerUserId`,`direction`,`status`);--> statement-breakpoint
CREATE INDEX `messages_timestamp_idx` ON `messages` (`timestamp`);--> statement-breakpoint
CREATE INDEX `messages_owner_contact_msgid_idx` ON `messages` (`ownerUserId`,`contactUserId`,`messageId`);--> statement-breakpoint
CREATE TABLE `pendingAnnouncements` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`announcement` blob NOT NULL,
	`fetchedAt` integer NOT NULL,
	`counter` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pending_announcements_announcement_idx` ON `pendingAnnouncements` (`announcement`);--> statement-breakpoint
CREATE INDEX `pending_announcements_fetchedAt_idx` ON `pendingAnnouncements` (`fetchedAt`);--> statement-breakpoint
CREATE TABLE `pendingEncryptedMessages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`seeker` blob NOT NULL,
	`ciphertext` blob NOT NULL,
	`fetchedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pending_encrypted_seeker_idx` ON `pendingEncryptedMessages` (`seeker`);--> statement-breakpoint
CREATE INDEX `pending_encrypted_fetchedAt_idx` ON `pendingEncryptedMessages` (`fetchedAt`);--> statement-breakpoint
CREATE TABLE `userProfile` (
	`userId` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`avatar` text,
	`bio` text,
	`status` text NOT NULL,
	`lastSeen` integer NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	`lastPublicKeyPush` integer,
	`security` text NOT NULL,
	`session` blob NOT NULL
);
--> statement-breakpoint
CREATE INDEX `userProfile_username_idx` ON `userProfile` (`username`);--> statement-breakpoint
CREATE INDEX `userProfile_status_idx` ON `userProfile` (`status`);