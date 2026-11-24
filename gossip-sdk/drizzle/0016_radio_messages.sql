CREATE TABLE `radioMessages` (
	`ownerUserId` text NOT NULL,
	`eventId` text NOT NULL,
	`syncObjId` text NOT NULL,
	`chatId` text NOT NULL,
	`direction` text NOT NULL,
	`olderKey` integer NOT NULL,
	`atMillis` integer NOT NULL,
	PRIMARY KEY(`ownerUserId`, `eventId`)
);
--> statement-breakpoint
CREATE INDEX `radioMessages_sync_obj_idx` ON `radioMessages` (`ownerUserId`,`syncObjId`);