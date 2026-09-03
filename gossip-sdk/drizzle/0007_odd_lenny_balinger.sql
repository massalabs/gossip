CREATE TABLE `privateMigration` (
	`id` integer PRIMARY KEY NOT NULL,
	`formatVersion` integer DEFAULT 1 NOT NULL,
	`installationEpoch` text NOT NULL,
	`completedPhase` integer DEFAULT 0 NOT NULL
);
