CREATE TABLE `server_access_retirements` (
	`host_id` text PRIMARY KEY NOT NULL,
	`provider_id` text,
	`grant_id` text,
	`acquisition_key` text NOT NULL,
	`server_url` text NOT NULL,
	`challenge` text NOT NULL,
	`primary_proof_runtime_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE cascade
);
