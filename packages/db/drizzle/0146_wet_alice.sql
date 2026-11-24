ALTER TABLE `threads` ADD `last_message_at` integer;
--> statement-breakpoint
UPDATE `threads`
SET `last_message_at` = (
  SELECT MAX(`events`.`created_at`)
  FROM `events`
  WHERE `events`.`thread_id` = `threads`.`id`
    AND (
      `events`.`type` IN ('client/turn/requested', 'system/manager/user_message')
      OR (`events`.`type` = 'item/completed' AND `events`.`item_kind` = 'agentMessage')
    )
);
