CREATE TABLE `managed_previews` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`host_id` text NOT NULL,
	`url` text NOT NULL,
	`endpoint` text NOT NULL,
	`cwd` text NOT NULL,
	`argv` text NOT NULL,
	`readiness_path` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `managed_previews_environment_endpoint_idx` ON `managed_previews` (`environment_id`,`endpoint`);--> statement-breakpoint
CREATE INDEX `managed_previews_thread_idx` ON `managed_previews` (`thread_id`);