ALTER TABLE `contacts` ADD `connection` text DEFAULT 'accepted' NOT NULL;--> statement-breakpoint
ALTER TABLE `discussions` ADD `isArchive` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `discussions` ADD `archived` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `discussions` ADD `linkedGroupId` text;--> statement-breakpoint
ALTER TABLE `discussions` ADD `directChatOwed` integer DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE `discussions` SET `isArchive` = 1 WHERE `contactUserId` <> '__self__';
