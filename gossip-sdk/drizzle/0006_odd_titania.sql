CREATE TABLE `accountSettings` (
	`userId` text PRIMARY KEY NOT NULL,
	`formatVersion` integer DEFAULT 1 NOT NULL,
	`mnsEnabled` integer DEFAULT false NOT NULL,
	`defaultRetentionDuration` integer DEFAULT 2592000
);
