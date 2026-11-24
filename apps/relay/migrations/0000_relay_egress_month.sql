CREATE TABLE `relay_egress_month` (
	`user_id` text NOT NULL REFERENCES `user`(`id`) ON DELETE CASCADE,
	`month` text NOT NULL CHECK (`month` GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
	`bytes` integer NOT NULL DEFAULT 0 CHECK (`bytes` >= 0),
	PRIMARY KEY (`user_id`, `month`)
);
