ALTER TABLE `users` ADD `misskey_id` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `users_misskey_id_unique` ON `users` (`misskey_id`);
--> statement-breakpoint
ALTER TABLE `oauth_states` ADD `code_verifier` text;
--> statement-breakpoint
ALTER TABLE `oauth_states` ADD `profile_url` text;
