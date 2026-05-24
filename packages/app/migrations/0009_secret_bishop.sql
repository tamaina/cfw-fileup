CREATE TABLE `file_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`file_id` text NOT NULL,
	`reporter_name` text NOT NULL,
	`reporter_email` text,
	`reason_id` text,
	`relationship_id` text,
	`contact` text,
	`summary` text NOT NULL,
	`detail` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`admin_note` text DEFAULT '' NOT NULL,
	`reporter_ip_address` text,
	`reporter_user_agent` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `file_reports_file_id_id_idx` ON `file_reports` (`file_id`,`id`);--> statement-breakpoint
CREATE INDEX `file_reports_status_id_idx` ON `file_reports` (`status`,`id`);