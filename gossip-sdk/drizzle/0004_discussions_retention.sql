ALTER TABLE `discussions` ADD COLUMN `messageRetentionDuration` integer;
--> statement-breakpoint
ALTER TABLE `discussions` ADD COLUMN `retentionPolicySetAt` integer;
