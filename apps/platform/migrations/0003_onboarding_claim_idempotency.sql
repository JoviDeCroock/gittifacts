CREATE TABLE `idempotency_keys` (
	`principal_id` text NOT NULL,
	`key` text NOT NULL,
	`request_hash` text NOT NULL,
	`status` integer,
	`response` text,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	PRIMARY KEY(`principal_id`, `key`)
);
--> statement-breakpoint
CREATE INDEX `idempotency_keys_expires_idx` ON `idempotency_keys` (`expires_at`);--> statement-breakpoint
ALTER TABLE `repos` ADD `claim_status` text DEFAULT 'claimed' NOT NULL;--> statement-breakpoint
ALTER TABLE `repos` ADD `claim_owner_id` text;--> statement-breakpoint
ALTER TABLE `repos` ADD `claim_expires_at` text;--> statement-breakpoint
ALTER TABLE `repos` ADD `template` text;--> statement-breakpoint
CREATE INDEX `repos_claim_expiry_idx` ON `repos` (`claim_status`,`claim_expires_at`);--> statement-breakpoint
CREATE INDEX `repos_claim_owner_idx` ON `repos` (`claim_owner_id`);--> statement-breakpoint
-- Existing repos were created by signed-in principals: they are claimed by their creator.
UPDATE `repos` SET `claim_owner_id` = `created_by` WHERE `claim_owner_id` IS NULL;
