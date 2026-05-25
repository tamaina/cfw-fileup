-- https://github.com/tamaina/cfw-fileup/issues/107
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
	`contract_address` text NOT NULL,
	`recipient_address` text NOT NULL,
	`amount_base_units` text NOT NULL,
	`decimals` integer NOT NULL,
	`duration_days` integer NOT NULL,
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
	`deployment_id` text NOT NULL,
	`plan_id` text NOT NULL,
	`amount_base_units` text NOT NULL,
	`duration_days` integer NOT NULL,
	`is_enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`deployment_id`) REFERENCES `payment_asset_deployments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`plan_id`) REFERENCES `plans`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `payment_asset_plan_prices_deployment_id_idx` ON `payment_asset_plan_prices` (`deployment_id`);--> statement-breakpoint
CREATE INDEX `payment_asset_plan_prices_plan_id_idx` ON `payment_asset_plan_prices` (`plan_id`);--> statement-breakpoint
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
