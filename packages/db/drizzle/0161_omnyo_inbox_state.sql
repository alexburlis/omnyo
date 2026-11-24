ALTER TABLE `plugin_state_snapshots` RENAME COLUMN "rollback_bb_version" TO "rollback_core_version";--> statement-breakpoint
CREATE TABLE `thread_failures` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`turn_id` text,
	`request_id` text,
	`wait_id` text,
	`state` text NOT NULL,
	`reason` text NOT NULL,
	`decision_deadline` integer,
	`retry_queued_message_id` text,
	`receipt_id` text,
	`incident_key` text,
	`incident_label` text,
	`reset_at` integer,
	`resolved_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`resolved_at` integer,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `thread_failures_thread_state_idx` ON `thread_failures` (`thread_id`,`state`);--> statement-breakpoint
CREATE INDEX `thread_failures_state_deadline_idx` ON `thread_failures` (`state`,`decision_deadline`);--> statement-breakpoint
CREATE TABLE `thread_moves` (
	`id` text PRIMARY KEY NOT NULL,
	`root_thread_id` text NOT NULL,
	`kind` text NOT NULL,
	`handled_receipt_ids` text NOT NULL,
	`write_set` text NOT NULL,
	`created_at` integer NOT NULL,
	`undone_at` integer,
	FOREIGN KEY (`root_thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `thread_moves_created_idx` ON `thread_moves` (`created_at`);--> statement-breakpoint
CREATE TABLE `thread_owner_inputs` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`kind` text NOT NULL,
	`state` text NOT NULL,
	`request_id` text,
	`queued_message_id` text,
	`turn_id` text,
	`receipt_id` text,
	`producer_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `thread_owner_inputs_thread_state_idx` ON `thread_owner_inputs` (`thread_id`,`state`);--> statement-breakpoint
CREATE INDEX `thread_owner_inputs_request_idx` ON `thread_owner_inputs` (`request_id`);--> statement-breakpoint
CREATE INDEX `thread_owner_inputs_queued_idx` ON `thread_owner_inputs` (`queued_message_id`);--> statement-breakpoint
CREATE INDEX `thread_owner_inputs_turn_idx` ON `thread_owner_inputs` (`thread_id`,`turn_id`);--> statement-breakpoint
CREATE TABLE `thread_producers` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`kind` text NOT NULL,
	`plugin_id` text NOT NULL,
	`label` text NOT NULL,
	`status` text NOT NULL,
	`held_turn_id` text,
	`held_summary` text,
	`held_until` integer,
	`ended_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`ended_at` integer,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `thread_producers_thread_status_idx` ON `thread_producers` (`thread_id`,`status`);--> statement-breakpoint
CREATE INDEX `thread_producers_held_idx` ON `thread_producers` (`held_until`);--> statement-breakpoint
CREATE TABLE `thread_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`root_thread_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`seq` integer NOT NULL,
	`cause` text NOT NULL,
	`summary` text NOT NULL,
	`outcome_ref` text,
	`wait_id` text,
	`covered_input_ids` text NOT NULL,
	`handled_at` integer,
	`handled_by_move_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`root_thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `thread_receipts_root_handled_idx` ON `thread_receipts` (`root_thread_id`,`handled_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `thread_receipts_root_seq_idx` ON `thread_receipts` (`root_thread_id`,`seq`);--> statement-breakpoint
CREATE TABLE `thread_turn_marks` (
	`thread_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`wait_id` text,
	`wait_generation` integer,
	`evaluation` integer NOT NULL,
	`rearmed` integer NOT NULL,
	`met_condition` text,
	`after_wait_id` text,
	`ended_owner_wait_ids` text NOT NULL,
	`created_at` integer NOT NULL,
	`ended_at` integer,
	`ended_outcome` text,
	PRIMARY KEY(`thread_id`, `turn_id`),
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `thread_wait_conditions` (
	`wait_id` text NOT NULL,
	`condition_key` text NOT NULL,
	`kind` text NOT NULL,
	`target` text,
	`label` text NOT NULL,
	`state` text NOT NULL,
	`after_seq` integer,
	`result` text,
	`met_at` integer,
	`stall_woken_at` integer,
	`stall_receipt_id` text,
	PRIMARY KEY(`wait_id`, `condition_key`),
	FOREIGN KEY (`wait_id`) REFERENCES `thread_waits`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `thread_wait_conditions_target_idx` ON `thread_wait_conditions` (`kind`,`target`);--> statement-breakpoint
CREATE TABLE `thread_wait_results` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`marker` text NOT NULL,
	`wait_id` text,
	`source_thread_id` text,
	`text` text NOT NULL,
	`late` integer NOT NULL,
	`received_at` integer NOT NULL,
	`consumed_at` integer,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `thread_wait_results_marker_idx` ON `thread_wait_results` (`marker`);--> statement-breakpoint
CREATE INDEX `thread_wait_results_thread_idx` ON `thread_wait_results` (`thread_id`);--> statement-breakpoint
CREATE TABLE `thread_waits` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`key` text NOT NULL,
	`generation` integer NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`readiness` text NOT NULL,
	`created_by` text NOT NULL,
	`automation_id` text,
	`owner_accepted` integer NOT NULL,
	`for_text` text NOT NULL,
	`resume_text` text,
	`marker` text NOT NULL,
	`deadline` integer,
	`chain_start_at` integer NOT NULL,
	`next_check_at` integer,
	`check_interval_ms` integer,
	`check_count` integer NOT NULL,
	`reminder_at` integer,
	`reminder_receipt_id` text,
	`question_id` text,
	`question_revision` integer,
	`covers_receipt_ids` text NOT NULL,
	`proposal_kind` text,
	`proposal_receipt_id` text,
	`after_wait_id` text,
	`dispatch_key` text,
	`dispatch_queued_message_id` text,
	`dispatch_request_id` text,
	`closed_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`closed_at` integer,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `thread_waits_key_generation_idx` ON `thread_waits` (`thread_id`,`key`,`generation`);--> statement-breakpoint
CREATE UNIQUE INDEX `thread_waits_dispatch_key_idx` ON `thread_waits` (`dispatch_key`);--> statement-breakpoint
CREATE INDEX `thread_waits_thread_status_idx` ON `thread_waits` (`thread_id`,`status`);--> statement-breakpoint
CREATE INDEX `thread_waits_status_deadline_idx` ON `thread_waits` (`status`,`deadline`);--> statement-breakpoint
CREATE INDEX `thread_waits_marker_idx` ON `thread_waits` (`marker`);--> statement-breakpoint
CREATE INDEX `thread_waits_dispatch_request_idx` ON `thread_waits` (`dispatch_request_id`);--> statement-breakpoint
CREATE INDEX `thread_waits_dispatch_queued_idx` ON `thread_waits` (`dispatch_queued_message_id`);