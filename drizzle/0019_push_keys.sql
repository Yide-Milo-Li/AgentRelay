CREATE TABLE `push_keys` (
	`owner_id` text PRIMARY KEY NOT NULL,
	`public_key` text NOT NULL,
	`private_key` text NOT NULL,
	`subject` text NOT NULL,
	`created_at` integer NOT NULL
);
