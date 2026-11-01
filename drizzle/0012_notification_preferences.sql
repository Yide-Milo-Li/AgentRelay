ALTER TABLE `notification_subscriptions` ADD `notify_requeue` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `notification_subscriptions` ADD `notify_any` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `notification_subscriptions` ADD `show_details` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `notification_subscriptions` ADD `label` text;--> statement-breakpoint
ALTER TABLE `notification_subscriptions` ADD `created_by_user_id` text;--> statement-breakpoint
ALTER TABLE `notification_subscriptions` ADD `created_by_name` text;