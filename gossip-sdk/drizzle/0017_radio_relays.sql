CREATE TABLE `radioRelays` (
	`ownerUserId` text NOT NULL,
	`groupId` text NOT NULL,
	`syncRef` text NOT NULL,
	`chatId` text NOT NULL,
	`author` text NOT NULL,
	`createdAt` integer NOT NULL,
	`text` text NOT NULL,
	`truncated` integer NOT NULL,
	`olderKey` integer NOT NULL,
	`atMillis` integer NOT NULL,
	PRIMARY KEY(`ownerUserId`, `syncRef`)
);
--> statement-breakpoint
CREATE INDEX `radioRelays_group_idx` ON `radioRelays` (`ownerUserId`,`groupId`);