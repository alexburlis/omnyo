UPDATE `plugins`
SET `provenance` = 'direct',
	`catalog_entry_id` = NULL,
	`catalog_marketplace_name` = NULL,
	`updated_at` = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE `provenance` = 'catalog'
  AND (`catalog_marketplace_name` = 'bb-community' OR `catalog_marketplace_name` IS NULL);--> statement-breakpoint
DELETE FROM `plugin_marketplace_icons`
WHERE `marketplace_name` = 'bb-community';--> statement-breakpoint
DELETE FROM `plugin_marketplaces`
WHERE `name` = 'bb-community';
