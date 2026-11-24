CREATE TABLE `native_thread_imports` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`host_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`source_provider_thread_id` text NOT NULL,
	`source_path` text NOT NULL,
	`imported_at` integer NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `native_thread_imports_source_idx` ON `native_thread_imports` (`host_id`,`provider_id`,`source_provider_thread_id`);