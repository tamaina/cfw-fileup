CREATE TABLE `misskey_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`misskey_id` text NOT NULL,
	`issuer` text NOT NULL,
	`username` text,
	`name` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `misskey_accounts_misskey_id_unique` ON `misskey_accounts` (`misskey_id`);
