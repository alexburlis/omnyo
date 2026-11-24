CREATE INDEX IF NOT EXISTS `threads_search_rank_idx` ON `threads` (`deleted_at`,`visibility`,`archived_at`,`updated_at`,`id`,`title`);
