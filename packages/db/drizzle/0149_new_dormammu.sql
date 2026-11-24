CREATE TABLE `thread_attention_imports` (
	`plugin_id` text PRIMARY KEY NOT NULL,
	`imported_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `thread_callbacks` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`id` text NOT NULL,
	`source_thread_id` text,
	`source_title` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` integer NOT NULL,
	`after_seq` integer NOT NULL,
	`match_text` text NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `thread_callbacks_source_idx` ON `thread_callbacks` (`source_thread_id`);--> statement-breakpoint
CREATE TABLE `thread_questions` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`revision` integer NOT NULL,
	`question` text NOT NULL,
	`mode` text NOT NULL,
	`key` text,
	`state` text NOT NULL,
	`answer` text,
	`queued_message_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `thread_questions_thread_state_idx` ON `thread_questions` (`thread_id`,`state`);