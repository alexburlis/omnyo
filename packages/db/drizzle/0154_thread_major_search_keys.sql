DROP TRIGGER IF EXISTS `thread_search_segments_after_text_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `thread_search_segments_after_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `thread_search_segments_after_insert`;
--> statement-breakpoint
DROP TABLE IF EXISTS `thread_search_segments_fts`;
--> statement-breakpoint
CREATE TABLE `__new_thread_search_segments` (
  `id` text PRIMARY KEY NOT NULL,
  `thread_id` text NOT NULL,
  `source_kind` text NOT NULL,
  `source_key` text NOT NULL,
  `source_seq` integer,
  `text` text NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_thread_search_segments` (
  `rowid`,
  `id`,
  `thread_id`,
  `source_kind`,
  `source_key`,
  `source_seq`,
  `text`,
  `created_at`,
  `updated_at`
)
SELECT
  (`threads`.`rowid` << 24) | CASE `segments`.`source_kind`
    WHEN 'title' THEN 0
    WHEN 'title_fallback' THEN 1
    ELSE 1 + ROW_NUMBER() OVER (
      PARTITION BY
        `segments`.`thread_id`,
        `segments`.`source_kind` IN ('title', 'title_fallback')
      ORDER BY `segments`.`source_seq`, `segments`.`rowid`
    )
  END,
  `segments`.`id`,
  `segments`.`thread_id`,
  `segments`.`source_kind`,
  `segments`.`source_key`,
  `segments`.`source_seq`,
  `segments`.`text`,
  `segments`.`created_at`,
  `segments`.`updated_at`
FROM `thread_search_segments` AS `segments`
JOIN `threads` ON `threads`.`id` = `segments`.`thread_id`;
--> statement-breakpoint
DROP TABLE `thread_search_segments`;
--> statement-breakpoint
ALTER TABLE `__new_thread_search_segments` RENAME TO `thread_search_segments`;
--> statement-breakpoint
CREATE UNIQUE INDEX `thread_search_segments_source_idx` ON `thread_search_segments` (`thread_id`, `source_kind`, `source_key`);
--> statement-breakpoint
CREATE INDEX `thread_search_segments_thread_source_seq_idx` ON `thread_search_segments` (`thread_id`,`source_seq`);
--> statement-breakpoint
CREATE VIRTUAL TABLE `thread_search_segments_fts` USING fts5(
  `text`,
  tokenize = 'unicode61',
  prefix = '2 3',
  content = '',
  contentless_delete = 1,
  detail = none
);
--> statement-breakpoint
INSERT INTO `thread_search_segments_fts` (`rowid`, `text`)
SELECT `rowid`, `text`
FROM `thread_search_segments`;
--> statement-breakpoint
CREATE TRIGGER `thread_search_segments_after_insert`
AFTER INSERT ON `thread_search_segments`
BEGIN
  INSERT INTO `thread_search_segments_fts` (`rowid`, `text`)
  VALUES (new.`rowid`, new.`text`);
END;
--> statement-breakpoint
CREATE TRIGGER `thread_search_segments_after_delete`
AFTER DELETE ON `thread_search_segments`
BEGIN
  DELETE FROM `thread_search_segments_fts`
  WHERE `rowid` = old.`rowid`;
END;
--> statement-breakpoint
CREATE TRIGGER `thread_search_segments_after_text_update`
AFTER UPDATE OF `id`, `text` ON `thread_search_segments`
WHEN old.`id` IS NOT new.`id` OR old.`text` IS NOT new.`text`
BEGIN
  DELETE FROM `thread_search_segments_fts`
  WHERE `rowid` = old.`rowid`;
  INSERT INTO `thread_search_segments_fts` (`rowid`, `text`)
  VALUES (new.`rowid`, new.`text`);
END;
