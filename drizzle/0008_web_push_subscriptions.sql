CREATE TABLE `notification_subscriptions` (
	`owner_id` text NOT NULL,
	`browser_id` text NOT NULL,
	`device_id` text NOT NULL,
	`endpoint` text NOT NULL,
	`endpoint_hash` text NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`locale` text DEFAULT 'en' NOT NULL,
	`disabled_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`last_attempt_at` integer,
	`last_accepted_at` integer,
	`last_error` text,
	PRIMARY KEY(`owner_id`, `browser_id`),
	FOREIGN KEY (`owner_id`,`device_id`) REFERENCES `devices`(`owner_id`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_subscriptions_owner_endpoint` ON `notification_subscriptions` (`owner_id`,`endpoint_hash`);--> statement-breakpoint
CREATE INDEX `notification_subscriptions_owner_device` ON `notification_subscriptions` (`owner_id`,`device_id`);