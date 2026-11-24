PRAGMA defer_foreign_keys = ON;--> statement-breakpoint
UPDATE `apikey`
SET `referenceId` = 'omnyo-machine-auth-system-user'
WHERE `referenceId` = 'bb-machine-auth-system-user'
  AND EXISTS (SELECT 1 FROM `user` WHERE `id` = 'bb-machine-auth-system-user')
  AND NOT EXISTS (SELECT 1 FROM `user` WHERE `id` = 'omnyo-machine-auth-system-user');--> statement-breakpoint
UPDATE `user`
SET `id` = 'omnyo-machine-auth-system-user'
WHERE `id` = 'bb-machine-auth-system-user'
  AND NOT EXISTS (SELECT 1 FROM `user` WHERE `id` = 'omnyo-machine-auth-system-user');
