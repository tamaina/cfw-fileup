CREATE TABLE `buckets` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `buckets_name_unique` ON `buckets` (`name`);--> statement-breakpoint
CREATE TABLE `files` (
	`id` text PRIMARY KEY NOT NULL,
	`bucket_id` text NOT NULL,
	`path` text NOT NULL,
	`r2_key` text NOT NULL,
	`size` integer,
	`mime_type` text,
	`is_public` integer DEFAULT true NOT NULL,
	`passphrase` text,
	`upload_expires_at` integer NOT NULL,
	`is_closed` integer DEFAULT false NOT NULL,
	`is_targz` integer DEFAULT false NOT NULL,
	`upload_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`bucket_id`) REFERENCES `buckets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `files_r2_key_unique` ON `files` (`r2_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `files_bucket_path_idx` ON `files` (`bucket_id`,`path`);--> statement-breakpoint
CREATE TABLE `targz_files` (
	`id` text PRIMARY KEY NOT NULL,
	`file_id` text NOT NULL,
	`path` text NOT NULL,
	`mime_type` text NOT NULL,
	`a_start` integer NOT NULL,
	`a_final_start` integer NOT NULL,
	`a_end` integer NOT NULL,
	`r_start_offset` integer NOT NULL,
	`r_end_offset` integer NOT NULL,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `upload_parts` (
	`id` text PRIMARY KEY NOT NULL,
	`file_id` text NOT NULL,
	`part_number` integer NOT NULL,
	`etag` text NOT NULL,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tokens_token_unique` ON `tokens` (`token`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`is_admin` integer DEFAULT false NOT NULL,
	`is_suspended` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);--> statement-breakpoint
CREATE TABLE `app_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
