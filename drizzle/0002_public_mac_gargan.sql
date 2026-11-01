CREATE TABLE `devices` (
	`owner_id` text NOT NULL,
	`id` text NOT NULL,
	`name` text NOT NULL,
	`name_key` text NOT NULL,
	`line` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	PRIMARY KEY(`owner_id`, `id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `devices_owner_name` ON `devices` (`owner_id`,`name_key`);--> statement-breakpoint
ALTER TABLE `agent_tokens` ADD `device_id` text;--> statement-breakpoint
ALTER TABLE `handoffs` ADD `source_device_id` text;--> statement-breakpoint
ALTER TABLE `handoffs` ADD `target_device_id` text;--> statement-breakpoint
ALTER TABLE `handoffs` ADD `claimed_by_device_id` text;--> statement-breakpoint
CREATE INDEX `handoffs_owner_target_device` ON `handoffs` (`owner_id`,`target_device_id`);