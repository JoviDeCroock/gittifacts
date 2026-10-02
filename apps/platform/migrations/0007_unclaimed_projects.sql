CREATE TABLE `platform_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text NOT NULL,
	`updated_by` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `project_claims` (
	`repo_id` text PRIMARY KEY NOT NULL,
	`agent_principal_id` text NOT NULL,
	`claim_token_hash` text NOT NULL,
	`creator_ip_hash` text NOT NULL,
	`creator_asn` integer,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`status` text NOT NULL,
	`claimed_at` text,
	`claimed_by` text,
	`expired_at` text,
	`project_name` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_claims_token_uq` ON `project_claims` (`claim_token_hash`);--> statement-breakpoint
CREATE INDEX `project_claims_status_expiry_idx` ON `project_claims` (`status`,`expires_at`);--> statement-breakpoint
CREATE INDEX `project_claims_ip_idx` ON `project_claims` (`creator_ip_hash`,`created_at`);--> statement-breakpoint
CREATE INDEX `project_claims_agent_idx` ON `project_claims` (`agent_principal_id`);--> statement-breakpoint
CREATE TABLE `unclaimed_creations` (
	`key_hash` text PRIMARY KEY NOT NULL,
	`request_hash` text NOT NULL,
	`principal_id` text NOT NULL,
	`repo_id` text,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `unclaimed_creations_expires_idx` ON `unclaimed_creations` (`expires_at`);