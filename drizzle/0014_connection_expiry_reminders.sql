ALTER TABLE `agent_tokens` ADD `expiry_reminded_lead` integer;--> statement-breakpoint
ALTER TABLE `notification_subscriptions` ADD `notify_expiry` text DEFAULT 'device' NOT NULL;