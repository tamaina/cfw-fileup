-- https://github.com/tamaina/cfw-fileup/pull/28
-- https://github.com/tamaina/cfw-fileup/pull/29
CREATE TABLE `oauth_states` (
	`id` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`code_verifier` text,
	`profile_url` text,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_states_state_unique` ON `oauth_states` (`state`);--> statement-breakpoint
ALTER TABLE `users` ADD `google_id` text;--> statement-breakpoint
ALTER TABLE `users` ADD `misskey_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `users_google_id_unique` ON `users` (`google_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_misskey_id_unique` ON `users` (`misskey_id`);
