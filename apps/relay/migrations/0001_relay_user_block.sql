CREATE TABLE `relay_user_block` (
	`user_id` text PRIMARY KEY NOT NULL REFERENCES `user`(`id`) ON DELETE CASCADE,
	`blocked_at` integer NOT NULL,
	`reason` text
);
