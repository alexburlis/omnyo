CREATE TABLE `relay_retired_label` (
	`label` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`github_id` text,
	`user_id` text NOT NULL,
	`retired_at` integer NOT NULL
);
CREATE INDEX `relay_retired_label_github_id_idx` ON `relay_retired_label` (`github_id`);
CREATE INDEX `relay_retired_label_user_id_idx` ON `relay_retired_label` (`user_id`);

CREATE TRIGGER `relay_label_claim_retire`
AFTER DELETE ON `label_claim`
BEGIN
	INSERT INTO `relay_retired_label` (`label`, `kind`, `github_id`, `user_id`, `retired_at`)
	VALUES (
		OLD.`label`,
		OLD.`kind`,
		(
			SELECT a.`account_id`
			FROM `account` a
			WHERE a.`user_id` = OLD.`user_id` AND a.`provider_id` = 'github'
			ORDER BY a.`created_at`
			LIMIT 1
		),
		OLD.`user_id`,
		CAST(unixepoch('subsec') * 1000 AS INTEGER)
	)
	ON CONFLICT (`label`) DO UPDATE SET
		`kind` = excluded.`kind`,
		`github_id` = COALESCE(`relay_retired_label`.`github_id`, excluded.`github_id`),
		`user_id` = excluded.`user_id`,
		`retired_at` = excluded.`retired_at`;
END;

CREATE TRIGGER `relay_label_claim_retired_guard`
BEFORE INSERT ON `label_claim`
WHEN EXISTS (
	SELECT 1
	FROM `relay_retired_label` r
	WHERE r.`label` = NEW.`label`
		AND r.`user_id` <> NEW.`user_id`
		AND (
			r.`github_id` IS NULL
			OR r.`github_id` NOT IN (
				SELECT a.`account_id`
				FROM `account` a
				WHERE a.`user_id` = NEW.`user_id` AND a.`provider_id` = 'github'
			)
		)
)
BEGIN
	SELECT RAISE(ABORT, 'relay label retired');
END;

CREATE TRIGGER `relay_label_claim_limit`
BEFORE INSERT ON `label_claim`
WHEN NOT EXISTS (
	SELECT 1
	FROM `relay_retired_label` r
	WHERE r.`label` = NEW.`label`
		AND (
			r.`user_id` = NEW.`user_id`
			OR r.`github_id` IN (
				SELECT a.`account_id`
				FROM `account` a
				WHERE a.`user_id` = NEW.`user_id` AND a.`provider_id` = 'github'
			)
		)
)
AND (
	SELECT COUNT(*)
	FROM (
		SELECT r.`label`
		FROM `relay_retired_label` r
		WHERE r.`user_id` = NEW.`user_id`
			OR r.`github_id` IN (
				SELECT a.`account_id`
				FROM `account` a
				WHERE a.`user_id` = NEW.`user_id` AND a.`provider_id` = 'github'
			)
		UNION
		SELECT c.`label`
		FROM `label_claim` c
		WHERE c.`user_id` = NEW.`user_id`
	)
) >= 40
BEGIN
	SELECT RAISE(ABORT, 'relay label limit');
END;
