CREATE INDEX `relay_machine_active_user_idx` ON `machine` (`user_id`) WHERE `revoked_at` IS NULL;
CREATE INDEX `relay_machine_revoked_at_idx` ON `machine` (`revoked_at`) WHERE `revoked_at` IS NOT NULL;
CREATE INDEX `relay_audit_log_created_at_idx` ON `audit_log` (`created_at`);
CREATE INDEX `relay_user_created_at_idx` ON `user` (`created_at`);
