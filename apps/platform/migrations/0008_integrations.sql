CREATE TABLE `account_handles` (
	`principal_id` text PRIMARY KEY NOT NULL,
	`handle` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`principal_id`) REFERENCES `principals`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `account_handles_handle_uq` ON `account_handles` (`handle`);--> statement-breakpoint
CREATE TABLE `deployment_statuses` (
	`id` text PRIMARY KEY NOT NULL,
	`deployment_id` text NOT NULL,
	`state` text NOT NULL,
	`url` text,
	`log_url` text,
	`description` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`deployment_id`) REFERENCES `deployments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `deployment_statuses_deployment_idx` ON `deployment_statuses` (`deployment_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `deployments` (
	`id` text PRIMARY KEY NOT NULL,
	`repo_id` text NOT NULL,
	`change_id` text,
	`installation_id` text NOT NULL,
	`integration_id` text NOT NULL,
	`principal_id` text NOT NULL,
	`sha` text NOT NULL,
	`ref` text,
	`environment` text NOT NULL,
	`state` text NOT NULL,
	`url` text,
	`log_url` text,
	`description` text,
	`evidence_status` text DEFAULT 'none' NOT NULL,
	`evidence_item_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`installation_id`) REFERENCES `installations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`integration_id`) REFERENCES `integrations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `deployments_repo_idx` ON `deployments` (`repo_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `deployments_change_idx` ON `deployments` (`change_id`,`sha`);--> statement-breakpoint
CREATE INDEX `deployments_evidence_idx` ON `deployments` (`evidence_status`,`change_id`);--> statement-breakpoint
CREATE TABLE `installation_repos` (
	`installation_id` text NOT NULL,
	`repo_id` text NOT NULL,
	PRIMARY KEY(`installation_id`, `repo_id`),
	FOREIGN KEY (`installation_id`) REFERENCES `installations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `installation_repos_repo_idx` ON `installation_repos` (`repo_id`);--> statement-breakpoint
CREATE TABLE `installations` (
	`id` text PRIMARY KEY NOT NULL,
	`integration_id` text NOT NULL,
	`account_id` text NOT NULL,
	`account_kind` text NOT NULL,
	`principal_id` text NOT NULL,
	`session_id` text NOT NULL,
	`installed_by` text NOT NULL,
	`repo_selection` text NOT NULL,
	`scopes` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	`deleted_by` text,
	FOREIGN KEY (`integration_id`) REFERENCES `integrations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `principals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`principal_id`) REFERENCES `principals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`installed_by`) REFERENCES `principals`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `installations_principal_uq` ON `installations` (`principal_id`);--> statement-breakpoint
CREATE INDEX `installations_integration_idx` ON `installations` (`integration_id`,`status`);--> statement-breakpoint
CREATE INDEX `installations_account_idx` ON `installations` (`account_id`,`status`);--> statement-breakpoint
CREATE TABLE `integration_authorizations` (
	`id` text PRIMARY KEY NOT NULL,
	`integration_id` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`state` text,
	`code_challenge` text NOT NULL,
	`requested_scopes` text NOT NULL,
	`audience` text NOT NULL,
	`status` text NOT NULL,
	`owner_id` text,
	`repo_selection` text,
	`granted_repo_ids` text,
	`installation_id` text,
	`code_hash` text,
	`code_expires_at` text,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`decided_at` text,
	FOREIGN KEY (`integration_id`) REFERENCES `integrations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_id`) REFERENCES `principals`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `integration_authorizations_code_uq` ON `integration_authorizations` (`code_hash`);--> statement-breakpoint
CREATE INDEX `integration_authorizations_expires_idx` ON `integration_authorizations` (`expires_at`);--> statement-breakpoint
CREATE TABLE `integration_secrets` (
	`id` text PRIMARY KEY NOT NULL,
	`integration_id` text NOT NULL,
	`secret_hash` text NOT NULL,
	`prefix` text NOT NULL,
	`created_at` text NOT NULL,
	`last_used_at` text,
	`revoked_at` text,
	FOREIGN KEY (`integration_id`) REFERENCES `integrations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `integration_secrets_hash_uq` ON `integration_secrets` (`secret_hash`);--> statement-breakpoint
CREATE INDEX `integration_secrets_integration_idx` ON `integration_secrets` (`integration_id`);--> statement-breakpoint
CREATE TABLE `integrations` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`logo_url` text,
	`homepage_url` text NOT NULL,
	`redirect_uris` text NOT NULL,
	`client_type` text NOT NULL,
	`scopes` text NOT NULL,
	`webhook_url` text,
	`webhook_secret_enc` text,
	`webhook_active` integer DEFAULT true NOT NULL,
	`webhook_events` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	FOREIGN KEY (`owner_id`) REFERENCES `principals`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `integrations_client_id_uq` ON `integrations` (`client_id`);--> statement-breakpoint
CREATE INDEX `integrations_owner_idx` ON `integrations` (`owner_id`);--> statement-breakpoint
CREATE TABLE `webhook_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`guid` text NOT NULL,
	`integration_id` text NOT NULL,
	`installation_id` text,
	`event` text NOT NULL,
	`action` text,
	`repo_id` text,
	`payload` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text,
	`last_attempt_at` text,
	`lease_until` text,
	`url` text,
	`response_status` integer,
	`response_body` text,
	`duration_ms` integer,
	`error` text,
	`redelivery_of` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`integration_id`) REFERENCES `integrations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `webhook_deliveries_integration_idx` ON `webhook_deliveries` (`integration_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `webhook_deliveries_installation_idx` ON `webhook_deliveries` (`installation_id`,`status`);--> statement-breakpoint
CREATE INDEX `webhook_deliveries_pending_idx` ON `webhook_deliveries` (`status`,`next_attempt_at`);