CREATE TABLE `attachment_bind_guard` (
	`handoff_id` text PRIMARY KEY NOT NULL,
	`expected` integer NOT NULL,
	`actual` integer NOT NULL,
	CONSTRAINT "attachment_bind_guard_match" CHECK("attachment_bind_guard"."expected" = "attachment_bind_guard"."actual")
);
--> statement-breakpoint
CREATE TABLE `attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`handoff_id` text,
	`position` integer,
	`filename` text NOT NULL,
	`mime_type` text NOT NULL,
	`byte_size` integer NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`sha256` text NOT NULL,
	`object_key` text NOT NULL,
	`upload_key` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attachments_owner_upload` ON `attachments` (`owner_id`,`upload_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `attachments_handoff_position` ON `attachments` (`handoff_id`,`position`) WHERE "attachments"."handoff_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `attachments_owner_handoff` ON `attachments` (`owner_id`,`handoff_id`);--> statement-breakpoint
CREATE INDEX `attachments_owner_state` ON `attachments` (`owner_id`,`state`,`handoff_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `object_cleanup` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`object_key` text NOT NULL,
	`byte_size` integer DEFAULT 0 NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `object_cleanup_owner` ON `object_cleanup` (`owner_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `handoffs` ADD `attachment_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `handoffs` ADD `attachment_bytes` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `handoffs_owner_logical` ON `handoffs` (`owner_id`,length(CAST("content" AS BLOB)) + "attachment_bytes",`id`,`status`,`expires_at`,`created_at`,`updated_at`,`attachment_count`,`attachment_bytes`);