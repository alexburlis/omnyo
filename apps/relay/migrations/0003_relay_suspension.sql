CREATE TABLE `relay_suspension` (
	`id` integer PRIMARY KEY NOT NULL,
	`github_id` text UNIQUE,
	`user_id` text UNIQUE,
	`blocked_at` integer NOT NULL,
	`reason` text,
	CHECK (`github_id` IS NOT NULL OR `user_id` IS NOT NULL)
);

INSERT OR IGNORE INTO `relay_suspension` (`github_id`, `user_id`, `blocked_at`, `reason`)
SELECT
	(
		SELECT a.`account_id`
		FROM `account` a
		WHERE a.`user_id` = b.`user_id` AND a.`provider_id` = 'github'
		ORDER BY a.`created_at`
		LIMIT 1
	),
	b.`user_id`,
	b.`blocked_at`,
	b.`reason`
FROM `relay_user_block` b;

DROP TABLE `relay_user_block`;
