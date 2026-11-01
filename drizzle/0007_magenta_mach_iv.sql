ALTER TABLE `agent_tokens` ADD `never_expires` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_tokens` ADD `last_authenticated_at` integer;