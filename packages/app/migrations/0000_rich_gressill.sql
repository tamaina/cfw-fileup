CREATE TABLE `buckets` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`used_bytes` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `buckets_name_unique` ON `buckets` (`name`);--> statement-breakpoint
CREATE TABLE `directories` (
	`id` text PRIMARY KEY NOT NULL,
	`bucket_id` text NOT NULL,
	`path` text NOT NULL,
	FOREIGN KEY (`bucket_id`) REFERENCES `buckets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `directories_bucket_path_idx` ON `directories` (`bucket_id`,`path`);--> statement-breakpoint
CREATE TABLE `file_access_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`file_id` text NOT NULL,
	`token` text NOT NULL,
	`expires_at` integer,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `file_access_tokens_token_unique` ON `file_access_tokens` (`token`);--> statement-breakpoint
CREATE TABLE `files` (
	`id` text PRIMARY KEY NOT NULL,
	`bucket_id` text NOT NULL,
	`user_id` text NOT NULL,
	`path` text NOT NULL,
	`r2_key` text NOT NULL,
	`size` integer,
	`mime_type` text,
	`visibility` text DEFAULT 'public' NOT NULL,
	`passphrase` text,
	`upload_expires_at` integer NOT NULL,
	`is_closed` integer DEFAULT false NOT NULL,
	`is_targz` integer DEFAULT false NOT NULL,
	`is_tar` integer DEFAULT false NOT NULL,
	`upload_id` text,
	`part_size` integer DEFAULT 33554432 NOT NULL,
	FOREIGN KEY (`bucket_id`) REFERENCES `buckets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `files_r2_key_unique` ON `files` (`r2_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `files_bucket_path_idx` ON `files` (`bucket_id`,`path`);--> statement-breakpoint
CREATE TABLE `tar_files` (
	`id` text PRIMARY KEY NOT NULL,
	`file_id` text NOT NULL,
	`path` text NOT NULL,
	`mime_type` text NOT NULL,
	`offset` integer NOT NULL,
	`size` integer NOT NULL,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `targz_files` (
	`id` text PRIMARY KEY NOT NULL,
	`file_id` text NOT NULL,
	`path` text NOT NULL,
	`mime_type` text NOT NULL,
	`a_start` integer NOT NULL,
	`a_first_end` integer NOT NULL,
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
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tokens_token_unique` ON `tokens` (`token`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`password_hash` text,
	`is_admin` integer DEFAULT false NOT NULL,
	`is_suspended` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);--> statement-breakpoint
CREATE TABLE `app_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `global_quotas` (
	`key` text PRIMARY KEY NOT NULL,
	`max_buckets` integer,
	`max_bucket_size_bytes` integer,
	`max_files_per_bucket` integer,
	`max_daily_uploads` integer
);
--> statement-breakpoint
CREATE TABLE `user_quotas` (
	`user_id` text PRIMARY KEY NOT NULL,
	`max_buckets` integer,
	`max_bucket_size_bytes` integer,
	`max_files_per_bucket` integer,
	`max_daily_uploads` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `backup_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`code_hash` text NOT NULL,
	`used_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `passkeys` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`credential_id` text NOT NULL,
	`public_key` text NOT NULL,
	`counter` integer DEFAULT 0 NOT NULL,
	`transports` text,
	`name` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `passkeys_credential_id_unique` ON `passkeys` (`credential_id`);--> statement-breakpoint
CREATE TABLE `passkeys_challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`challenge` text NOT NULL,
	`user_id` text,
	`type` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `used_bucket_names` (
	`bucket_name` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE `used_usernames` (
	`username` text PRIMARY KEY NOT NULL
);
