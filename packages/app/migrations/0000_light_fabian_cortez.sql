-- PR URL: TBD
CREATE TABLE `crypto_payment_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`payer_wallet_id` text,
	`payer_address` text NOT NULL,
	`price_id` text,
	`deployment_id` text,
	`plan_id` text NOT NULL,
	`asset_id` text,
	`chain_id` integer NOT NULL,
	`chain_name` text NOT NULL,
	`asset_symbol` text NOT NULL,
	`asset_name` text NOT NULL,
	`plan_name` text NOT NULL,
	`contract_address` text NOT NULL,
	`recipient_address` text NOT NULL,
	`amount_base_units` text NOT NULL,
	`decimals` integer NOT NULL,
	`duration_days` integer NOT NULL,
	`duration_unit` text DEFAULT 'days' NOT NULL,
	`quote_created_at` integer NOT NULL,
	`quote_expires_at` integer NOT NULL,
	`quote_base_amount_base_units` text NOT NULL,
	`quote_discount_base_units` text NOT NULL,
	`quote_effective_expires_at` integer NOT NULL,
	`quote_current_plan_id` text,
	`quote_current_plan_name` text,
	`quote_current_plan_expires_at` integer,
	`quote_current_plan_price_amount_base_units` text,
	`quote_current_plan_price_duration_days` integer,
	`quote_current_plan_price_duration_unit` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`tx_hash` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`paid_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`payer_wallet_id`) REFERENCES `user_wallets`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`price_id`) REFERENCES `payment_asset_plan_prices`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`deployment_id`) REFERENCES `payment_asset_deployments`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`plan_id`) REFERENCES `plans`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`asset_id`) REFERENCES `payment_assets`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `crypto_payment_orders_user_id_id_idx` ON `crypto_payment_orders` (`user_id`,`id`);--> statement-breakpoint
CREATE INDEX `crypto_payment_orders_status_expires_at_idx` ON `crypto_payment_orders` (`status`,`expires_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `crypto_payment_orders_chain_tx_hash_idx` ON `crypto_payment_orders` (`chain_id`,`tx_hash`);--> statement-breakpoint
CREATE TABLE `payment_asset_deployments` (
	`id` text PRIMARY KEY NOT NULL,
	`asset_id` text NOT NULL,
	`chain_id` integer NOT NULL,
	`token_symbol` text NOT NULL,
	`token_name` text NOT NULL,
	`contract_address` text NOT NULL,
	`decimals` integer NOT NULL,
	`recipient_address` text NOT NULL,
	`is_enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`asset_id`) REFERENCES `payment_assets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`chain_id`) REFERENCES `payment_chains`(`chain_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payment_asset_deployments_chain_contract_idx` ON `payment_asset_deployments` (`chain_id`,`contract_address`);--> statement-breakpoint
CREATE INDEX `payment_asset_deployments_asset_id_idx` ON `payment_asset_deployments` (`asset_id`);--> statement-breakpoint
CREATE TABLE `payment_asset_plan_prices` (
	`id` text PRIMARY KEY NOT NULL,
	`asset_id` text NOT NULL,
	`plan_id` text NOT NULL,
	`amount_base_units` text NOT NULL,
	`duration_days` integer NOT NULL,
	`duration_unit` text DEFAULT 'days' NOT NULL,
	`is_enabled` integer DEFAULT true NOT NULL,
	`expires_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`asset_id`) REFERENCES `payment_assets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`plan_id`) REFERENCES `plans`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `payment_asset_plan_prices_asset_id_idx` ON `payment_asset_plan_prices` (`asset_id`);--> statement-breakpoint
CREATE INDEX `payment_asset_plan_prices_plan_id_idx` ON `payment_asset_plan_prices` (`plan_id`);--> statement-breakpoint
CREATE INDEX `payment_asset_plan_prices_expires_at_idx` ON `payment_asset_plan_prices` (`expires_at`);--> statement-breakpoint
CREATE TABLE `payment_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`symbol` text NOT NULL,
	`name` text NOT NULL,
	`is_enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `payment_chains` (
	`chain_id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`native_currency_name` text NOT NULL,
	`native_currency_symbol` text NOT NULL,
	`native_currency_decimals` integer NOT NULL,
	`block_explorer_url` text,
	`confirmations_required` integer DEFAULT 1 NOT NULL,
	`is_enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
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
	`is_listed` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`bucket_id`) REFERENCES `buckets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `directories_bucket_path_idx` ON `directories` (`bucket_id`,`path`);--> statement-breakpoint
CREATE TABLE `file_access_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`file_id` text NOT NULL,
	`token` blob NOT NULL,
	`expires_at` integer,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `file_access_tokens_token_unique` ON `file_access_tokens` (`token`);--> statement-breakpoint
CREATE TABLE `file_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`file_id` text NOT NULL,
	`reporter_user_id` text,
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
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`reporter_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `file_reports_file_id_id_idx` ON `file_reports` (`file_id`,`id`);--> statement-breakpoint
CREATE INDEX `file_reports_status_id_idx` ON `file_reports` (`status`,`id`);--> statement-breakpoint
CREATE TABLE `files` (
	`id` text PRIMARY KEY NOT NULL,
	`bucket_id` text NOT NULL,
	`user_id` text NOT NULL,
	`path` text NOT NULL,
	`r2_key` text NOT NULL,
	`size` integer,
	`mime_type` text,
	`visibility` text DEFAULT 'public' NOT NULL,
	`is_listed` integer DEFAULT true NOT NULL,
	`is_moderation_forced_private` integer DEFAULT false NOT NULL,
	`download_count` integer DEFAULT 0 NOT NULL,
	`is_download_count_enabled` integer DEFAULT false NOT NULL,
	`is_download_count_visible` integer DEFAULT false NOT NULL,
	`passphrase_hash` blob,
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
CREATE UNIQUE INDEX `upload_parts_file_part_idx` ON `upload_parts` (`file_id`,`part_number`);--> statement-breakpoint
CREATE TABLE `oauth_states` (
	`id` text PRIMARY KEY NOT NULL,
	`state` blob NOT NULL,
	`code_verifier` blob,
	`profile_url` text,
	`link_user_id` text,
	`signup_passphrase` text,
	`signup_username` text,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`link_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_states_state_unique` ON `oauth_states` (`state`);--> statement-breakpoint
CREATE TABLE `tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token` blob NOT NULL,
	`is_revoked` integer DEFAULT false NOT NULL,
	`reauthenticated_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tokens_token_unique` ON `tokens` (`token`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`password_hash` blob,
	`google_id` text,
	`misskey_id` text,
	`is_admin` integer DEFAULT false NOT NULL,
	`is_suspended` integer DEFAULT false NOT NULL,
	`terms_agreed_at` integer,
	`effective_max_buckets` integer,
	`effective_max_bucket_size_bytes` integer,
	`effective_max_files_per_bucket` integer,
	`effective_max_daily_uploads` integer,
	`effective_can_use_download_count` integer DEFAULT false NOT NULL,
	`effective_quota_expires_at` integer,
	`effective_quota_updated_at` integer,
	`effective_quota_source` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_google_id_unique` ON `users` (`google_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_misskey_id_unique` ON `users` (`misskey_id`);--> statement-breakpoint
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
	`max_daily_uploads` integer,
	`can_use_download_count` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE `plans` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`max_buckets` integer,
	`max_bucket_size_bytes` integer,
	`max_files_per_bucket` integer,
	`max_daily_uploads` integer,
	`can_use_download_count` integer DEFAULT false NOT NULL,
	`is_enabled` integer DEFAULT true NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `user_plan_assignments` (
	`user_id` text PRIMARY KEY NOT NULL,
	`plan_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`plan_id`) REFERENCES `plans`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `user_quotas` (
	`user_id` text PRIMARY KEY NOT NULL,
	`max_buckets` integer,
	`max_bucket_size_bytes` integer,
	`max_files_per_bucket` integer,
	`max_daily_uploads` integer,
	`can_use_download_count` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `backup_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`code_hash` blob NOT NULL,
	`used_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `passkeys` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`credential_id` blob NOT NULL,
	`public_key` blob NOT NULL,
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
	`challenge` blob NOT NULL,
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
--> statement-breakpoint
CREATE TABLE `ip_bans` (
	`id` text PRIMARY KEY NOT NULL,
	`cidr` text NOT NULL,
	`reason` text,
	`source_event_id` text,
	`created_by` text,
	`expires_at` integer,
	FOREIGN KEY (`source_event_id`) REFERENCES `moderation_events`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ip_bans_cidr_unique` ON `ip_bans` (`cidr`);--> statement-breakpoint
CREATE TABLE `moderation_audit_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`admin_user_id` text,
	`action` text NOT NULL,
	`target_file_id` text,
	`target_user_id` text,
	`data` text,
	FOREIGN KEY (`admin_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`target_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `moderation_audit_logs_admin_user_id_id_idx` ON `moderation_audit_logs` (`admin_user_id`,`id`);--> statement-breakpoint
CREATE INDEX `moderation_audit_logs_target_file_id_id_idx` ON `moderation_audit_logs` (`target_file_id`,`id`);--> statement-breakpoint
CREATE INDEX `moderation_audit_logs_target_user_id_id_idx` ON `moderation_audit_logs` (`target_user_id`,`id`);--> statement-breakpoint
CREATE TABLE `moderation_events` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`user_token_id` text,
	`action` text NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`data` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`user_token_id`) REFERENCES `tokens`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `moderation_events_user_token_id_id_idx` ON `moderation_events` (`user_token_id`,`id`);--> statement-breakpoint
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
CREATE UNIQUE INDEX `misskey_accounts_misskey_id_unique` ON `misskey_accounts` (`misskey_id`);--> statement-breakpoint
CREATE TABLE `user_wallets` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`chain_id` integer NOT NULL,
	`address` text NOT NULL,
	`label` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `user_wallets_user_id_idx` ON `user_wallets` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `user_wallets_chain_address_idx` ON `user_wallets` (`chain_id`,`address`);--> statement-breakpoint
CREATE TABLE `wallet_link_challenges` (
	`nonce` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`chain_id` integer NOT NULL,
	`address` text NOT NULL,
	`domain` text NOT NULL,
	`uri` text NOT NULL,
	`message` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `wallet_link_challenges_user_id_idx` ON `wallet_link_challenges` (`user_id`);--> statement-breakpoint
CREATE INDEX `wallet_link_challenges_expires_at_idx` ON `wallet_link_challenges` (`expires_at`);
