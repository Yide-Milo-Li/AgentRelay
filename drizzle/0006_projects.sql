CREATE TABLE `projects` (
	`owner_id` text NOT NULL,
	`id` text NOT NULL,
	`name` text NOT NULL,
	`name_key` text NOT NULL,
	`line` text NOT NULL,
	`archived_at` integer,
	`last_used_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	PRIMARY KEY(`owner_id`, `id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_owner_name` ON `projects` (`owner_id`,`name_key`);--> statement-breakpoint
ALTER TABLE `handoffs` ADD `project_id` text;--> statement-breakpoint
CREATE INDEX `handoffs_owner_project` ON `handoffs` (`owner_id`,`project_id`,`created_at`);