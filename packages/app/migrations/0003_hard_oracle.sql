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
ALTER TABLE `files` ADD `is_tar` integer DEFAULT false NOT NULL;