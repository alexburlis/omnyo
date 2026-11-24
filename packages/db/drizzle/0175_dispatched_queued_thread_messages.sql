CREATE TABLE `dispatched_queued_thread_messages` (
	`queued_message_id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`dispatched_at` integer NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `dispatched_queued_thread_messages_dispatched_at_idx` ON `dispatched_queued_thread_messages` (`dispatched_at`);