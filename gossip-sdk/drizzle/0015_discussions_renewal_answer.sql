ALTER TABLE `discussions` ADD `awaitingAnswer` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `discussions` ADD `renewalAnsweredAt` integer;--> statement-breakpoint
ALTER TABLE `discussions` ADD `renewalAnswerOwed` integer DEFAULT false NOT NULL;