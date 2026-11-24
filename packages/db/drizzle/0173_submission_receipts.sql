CREATE TABLE `coordinator_store` (
	`singleton` integer PRIMARY KEY NOT NULL,
	`store_id` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `submission_receipts` (
	`actor_key` text NOT NULL,
	`submission_id` text NOT NULL,
	`action` text NOT NULL,
	`intent_digest` text NOT NULL,
	`thread_id` text NOT NULL,
	`queued_message_id` text NOT NULL,
	`accepted_at` integer NOT NULL,
	PRIMARY KEY(`actor_key`, `submission_id`)
);
