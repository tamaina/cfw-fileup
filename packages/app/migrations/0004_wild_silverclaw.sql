CREATE TABLE `billing_guards` (
	`id` text PRIMARY KEY NOT NULL,
	`valid` integer NOT NULL,
	CONSTRAINT "billing_guard_valid" CHECK("billing_guards"."valid" = 1)
);
--> statement-breakpoint
CREATE TABLE `billing_states` (
	`user_id` text PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`lock_request_id` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `billing_transaction_claims` (
	`chain_id` integer NOT NULL,
	`tx_hash` text NOT NULL,
	`owner_id` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `billing_transaction_proof_idx` ON `billing_transaction_claims` (`chain_id`,`tx_hash`);--> statement-breakpoint
CREATE TABLE `plan_funding_lots` (
	`id` text PRIMARY KEY NOT NULL,
	`assignment_id` text NOT NULL,
	`source_order_id` text NOT NULL,
	`basis_amount_base_units` text NOT NULL,
	`basis_starts_at` integer NOT NULL,
	`basis_expires_at` integer NOT NULL,
	`starts_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`assignment_id`) REFERENCES `user_plan_assignments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_order_id`) REFERENCES `crypto_payment_orders`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `plan_funding_assignment_idx` ON `plan_funding_lots` (`assignment_id`);--> statement-breakpoint
CREATE TABLE `refund_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`requested_cutoff_at` integer NOT NULL,
	`requested_mode` text NOT NULL,
	`effective_cutoff_at` integer,
	`adjustment_reason` text DEFAULT '' NOT NULL,
	`decision_reason` text DEFAULT '' NOT NULL,
	`actor_user_id` text,
	`status` text DEFAULT 'requested' NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`quote` text,
	`seller` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `refund_request_idempotency_idx` ON `refund_requests` (`user_id`,`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `refund_request_open_user_idx` ON `refund_requests` (`user_id`) WHERE "refund_requests"."status" IN ('requested', 'review_required', 'prepared', 'processing');--> statement-breakpoint
CREATE TABLE `refund_source_claims` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`source_order_id` text NOT NULL,
	`amount_base_units` text NOT NULL,
	FOREIGN KEY (`request_id`) REFERENCES `refund_requests`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`source_order_id`) REFERENCES `crypto_payment_orders`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `refund_source_order_idx` ON `refund_source_claims` (`source_order_id`);--> statement-breakpoint
CREATE TABLE `refund_transfers` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`chain_id` integer NOT NULL,
	`confirmations_required` integer DEFAULT 1 NOT NULL,
	`sender_address` text,
	`tx_hash` text,
	`status` text DEFAULT 'prepared' NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`started_at` integer,
	`block_hash` text,
	`block_number` text,
	`log_index` integer,
	FOREIGN KEY (`request_id`) REFERENCES `refund_requests`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `refund_transfer_request_idx` ON `refund_transfers` (`request_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `refund_transfer_proof_idx` ON `refund_transfers` (`chain_id`,`tx_hash`);--> statement-breakpoint
ALTER TABLE `crypto_payment_orders` ADD `billing_revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `user_plan_assignments` ADD `refund_provenance_complete` integer DEFAULT false NOT NULL;