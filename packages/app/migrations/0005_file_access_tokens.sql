CREATE TABLE `file_access_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`file_id` text NOT NULL,
	`token` text NOT NULL,
	`expires_at` integer,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `file_access_tokens_token_unique` ON `file_access_tokens` (`token`);
