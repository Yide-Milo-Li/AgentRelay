CREATE TABLE `connection_events` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`token_id` text,
	`token_name` text NOT NULL,
	`kind` text NOT NULL,
	`actor_name` text,
	`at` integer NOT NULL,
	`detail` text
);
--> statement-breakpoint
CREATE INDEX `connection_events_owner_at` ON `connection_events` (`owner_id`,`at`);--> statement-breakpoint
CREATE INDEX `connection_events_owner_token` ON `connection_events` (`owner_id`,`token_id`,`at`);--> statement-breakpoint
ALTER TABLE `agent_tokens` ADD `version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_tokens` ADD `revoked_by_name` text;--> statement-breakpoint
ALTER TABLE `agent_tokens` ADD `revoked_reason` text;