CREATE TABLE `daemon_event_receipts` (
	`host_id` text NOT NULL,
	`instance_id` text NOT NULL,
	`last_event_index` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`host_id`, `instance_id`),
	FOREIGN KEY (`host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE cascade
);
