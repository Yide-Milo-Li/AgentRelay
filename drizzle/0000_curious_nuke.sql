CREATE TABLE `handoffs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`title` text NOT NULL,
	`project` text DEFAULT '' NOT NULL,
	`source_device` text NOT NULL,
	`target_device` text NOT NULL,
	`content` text NOT NULL,
	`status` text DEFAULT 'ready' NOT NULL,
	`claimed_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`expires_at` integer,
	`version` integer DEFAULT 1 NOT NULL,
	`request_key` text
);
--> statement-breakpoint
CREATE INDEX `handoffs_owner_created` ON `handoffs` (`owner_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `handoffs_owner_request` ON `handoffs` (`owner_id`,`request_key`);