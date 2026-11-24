UPDATE `thread_waits`
SET `status` = 'closed',
    `closed_reason` = 'continued',
    `closed_at` = CAST(strftime('%s', 'now') AS INTEGER) * 1000,
    `updated_at` = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE `status` IN ('dispatched', 'evaluating')
  AND EXISTS (
    SELECT 1
    FROM `thread_turn_marks` AS `mark`
    WHERE `mark`.`thread_id` = `thread_waits`.`thread_id`
      AND `mark`.`wait_id` = `thread_waits`.`id`
      AND `mark`.`after_wait_id` IS NOT NULL
      AND `mark`.`rearmed` = 0
      AND `mark`.`ended_at` IS NOT NULL
      AND `mark`.`ended_outcome` = 'completed'
  );
