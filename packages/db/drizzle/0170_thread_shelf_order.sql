ALTER TABLE `threads` ADD `shelf_sort_key` text;--> statement-breakpoint
WITH RECURSIVE `shelf_roots`(`id`, `shelf_sort_key`) AS (
	SELECT `id`, printf('V%08d', ROW_NUMBER() OVER (ORDER BY `shelved_at` DESC, `id` DESC))
	FROM `threads`
	WHERE `shelved_at` IS NOT NULL AND `parent_thread_id` IS NULL
), `shelf_families`(`id`, `shelf_sort_key`) AS (
	SELECT `id`, `shelf_sort_key` FROM `shelf_roots`
	UNION ALL
	SELECT `threads`.`id`, `shelf_families`.`shelf_sort_key`
	FROM `threads` JOIN `shelf_families` ON `threads`.`parent_thread_id` = `shelf_families`.`id`
)
UPDATE `threads`
SET `shelf_sort_key` = (SELECT `shelf_families`.`shelf_sort_key` FROM `shelf_families` WHERE `shelf_families`.`id` = `threads`.`id`)
WHERE `shelved_at` IS NOT NULL AND `id` IN (SELECT `id` FROM `shelf_families`);
