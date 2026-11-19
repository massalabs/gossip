CREATE TABLE `groupEdges` (
	`ownerUserId` text NOT NULL,
	`chatId` text NOT NULL,
	`eventId` text NOT NULL,
	`parents` text NOT NULL,
	PRIMARY KEY(`ownerUserId`, `chatId`, `eventId`)
);
--> statement-breakpoint
CREATE TABLE `groupEventRows` (
	`ownerUserId` text NOT NULL,
	`chatId` text NOT NULL,
	`eventId` text NOT NULL,
	`state` text NOT NULL,
	`fields` text,
	PRIMARY KEY(`ownerUserId`, `chatId`, `eventId`)
);
--> statement-breakpoint
CREATE TABLE `groupObjects` (
	`ownerUserId` text NOT NULL,
	`chatId` text NOT NULL,
	`syncObjId` text NOT NULL,
	`fields` text NOT NULL,
	PRIMARY KEY(`ownerUserId`, `chatId`, `syncObjId`)
);
--> statement-breakpoint
CREATE TABLE `groupOutbox` (
	`id` integer PRIMARY KEY NOT NULL,
	`ownerUserId` text NOT NULL,
	`contactUserId` text NOT NULL,
	`seeker` blob NOT NULL,
	`ciphertext` blob NOT NULL,
	`whenToSend` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `group_outbox_owner_idx` ON `groupOutbox` (`ownerUserId`);--> statement-breakpoint
CREATE TABLE `groupRecords` (
	`ownerUserId` text NOT NULL,
	`kind` text NOT NULL,
	`key` text NOT NULL,
	`fields` text NOT NULL,
	PRIMARY KEY(`ownerUserId`, `kind`, `key`)
);
