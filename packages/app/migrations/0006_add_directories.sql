CREATE TABLE `directories` (
	`id` text PRIMARY KEY NOT NULL,
	`bucket_id` text NOT NULL,
	`path` text NOT NULL,
	FOREIGN KEY (`bucket_id`) REFERENCES `buckets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `directories_bucket_path_idx` ON `directories` (`bucket_id`,`path`);
