DROP TRIGGER `relay_label_claim_retire`;

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
		`github_id` = COALESCE(`relay_retired_label`.`github_id`, excluded.`github_id`),
		`user_id` = excluded.`user_id`,
		`retired_at` = excluded.`retired_at`;
END;

DROP TRIGGER `relay_label_claim_limit`;

CREATE TRIGGER `relay_label_claim_limit`
BEFORE INSERT ON `label_claim`
WHEN NOT (
	NEW.`kind` = 'machine'
	AND (
		NEW.`label` GLOB 'machine-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
		OR (
			NEW.`label` GLOB 'machine-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9]*'
			AND substr(NEW.`label`, 18) NOT GLOB '*[^0-9]*'
		)
	)
)
AND NOT EXISTS (
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
		WHERE (
				r.`user_id` = NEW.`user_id`
				OR r.`github_id` IN (
					SELECT a.`account_id`
					FROM `account` a
					WHERE a.`user_id` = NEW.`user_id` AND a.`provider_id` = 'github'
				)
			)
			AND (r.`kind` = 'machine') = (NEW.`kind` = 'machine')
			AND NOT (
				r.`kind` = 'machine'
				AND (
					r.`label` GLOB 'machine-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
					OR (
						r.`label` GLOB 'machine-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9]*'
						AND substr(r.`label`, 18) NOT GLOB '*[^0-9]*'
					)
				)
			)
		UNION
		SELECT c.`label`
		FROM `label_claim` c
		WHERE c.`user_id` = NEW.`user_id`
			AND (c.`kind` = 'machine') = (NEW.`kind` = 'machine')
			AND NOT (
				c.`kind` = 'machine'
				AND (
					c.`label` GLOB 'machine-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
					OR (
						c.`label` GLOB 'machine-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9]*'
						AND substr(c.`label`, 18) NOT GLOB '*[^0-9]*'
					)
				)
			)
	)
) >= 40
BEGIN
	SELECT RAISE(ABORT, 'relay label limit');
END;
