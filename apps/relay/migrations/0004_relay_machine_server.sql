CREATE TABLE `relay_machine_server` (
	`machine_id` text PRIMARY KEY NOT NULL REFERENCES `machine`(`id`) ON DELETE CASCADE,
	`server_id` text NOT NULL,
	`created_at` integer NOT NULL
);
