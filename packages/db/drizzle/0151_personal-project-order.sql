UPDATE `projects`
SET `sort_key` = COALESCE((
  SELECT MAX(`sort_key`) || 'U'
  FROM `projects`
  WHERE `kind` = 'standard' AND `deleted_at` IS NULL
), 'V')
WHERE `id` = 'proj_personal' AND `kind` = 'personal';
