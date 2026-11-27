CREATE TABLE `groupLocalState` (
	`ownerUserId` text NOT NULL,
	`groupId` text NOT NULL,
	`archived` integer NOT NULL,
	PRIMARY KEY(`ownerUserId`, `groupId`)
);
