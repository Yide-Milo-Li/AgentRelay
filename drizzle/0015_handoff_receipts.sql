ALTER TABLE `handoffs` ADD `result` text;--> statement-breakpoint
ALTER TABLE `handoffs` ADD `reply_to_id` text;--> statement-breakpoint
ALTER TABLE `handoffs` ADD `thread_id` text;--> statement-breakpoint
CREATE INDEX `handoffs_owner_thread` ON `handoffs` (`owner_id`,`thread_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `handoffs_owner_logical_v2` ON `handoffs` (`owner_id`,length(CAST("content" AS BLOB)) + length(CAST(coalesce("result", '') AS BLOB)) + "attachment_bytes",`id`,`status`,`expires_at`,`created_at`,`updated_at`,`attachment_count`,`attachment_bytes`);