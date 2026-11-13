CREATE TABLE `discardedPeers` (
	`ownerUserId` text NOT NULL,
	`userId` text NOT NULL,
	`announcementFloorMillis` integer NOT NULL,
	PRIMARY KEY(`ownerUserId`, `userId`)
);
--> statement-breakpoint
CREATE TABLE `transportCursors` (
	`userId` text PRIMARY KEY NOT NULL,
	`cursors` text NOT NULL
);
