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
