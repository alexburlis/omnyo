CREATE TABLE `thread_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `thread_groups_project_idx` ON `thread_groups` (`project_id`);--> statement-breakpoint
ALTER TABLE `threads` ADD `group_id` text REFERENCES thread_groups(id) ON DELETE SET NULL;--> statement-breakpoint
CREATE INDEX `threads_group_idx` ON `threads` (`group_id`);