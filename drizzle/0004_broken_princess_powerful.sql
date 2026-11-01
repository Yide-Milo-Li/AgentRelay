ALTER TABLE `agent_tokens` ADD `created_by_user_id` text;--> statement-breakpoint
ALTER TABLE `agent_tokens` ADD `created_by_name` text;--> statement-breakpoint
ALTER TABLE `handoffs` ADD `created_by_user_id` text;--> statement-breakpoint
ALTER TABLE `handoffs` ADD `created_by_name` text;