CREATE TABLE `device_code` (
	`id` text PRIMARY KEY NOT NULL,
	`device_code` text NOT NULL,
	`user_code` text NOT NULL,
	`user_id` text,
	`expires_at` integer NOT NULL,
	`status` text NOT NULL,
	`last_polled_at` integer,
	`polling_interval` integer,
	`client_id` text,
	`scope` text,
	`client_name` text,
	`audience` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `deviceCode_deviceCode_uidx` ON `device_code` (`device_code`);--> statement-breakpoint
CREATE UNIQUE INDEX `deviceCode_userCode_uidx` ON `device_code` (`user_code`);--> statement-breakpoint
CREATE TABLE `agent_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`principal_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`flow` text NOT NULL,
	`client_id` text NOT NULL,
	`client_name` text NOT NULL,
	`client_uri` text,
	`audience` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`revoked_at` text,
	`revoked_by` text,
	FOREIGN KEY (`principal_id`) REFERENCES `principals`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_id`) REFERENCES `principals`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_sessions_principal_uq` ON `agent_sessions` (`principal_id`);--> statement-breakpoint
CREATE INDEX `agent_sessions_owner_idx` ON `agent_sessions` (`owner_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `oauth_refresh_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`rotated_at` text,
	`revoked_at` text,
	FOREIGN KEY (`session_id`) REFERENCES `agent_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_refresh_tokens_hash_uq` ON `oauth_refresh_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `oauth_refresh_tokens_session_idx` ON `oauth_refresh_tokens` (`session_id`);--> statement-breakpoint
CREATE TABLE `oauth_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`flow` text NOT NULL,
	`client_id` text NOT NULL,
	`client_name` text NOT NULL,
	`client_uri` text,
	`client_kind` text NOT NULL,
	`redirect_uri` text,
	`state` text,
	`code_challenge` text,
	`device_code_id` text,
	`audience` text NOT NULL,
	`requested_scopes` text NOT NULL,
	`status` text NOT NULL,
	`owner_id` text,
	`granted_scopes` text,
	`granted_repo_ids` text,
	`session_days` integer,
	`agent_name` text,
	`code_hash` text,
	`code_expires_at` text,
	`session_id` text,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`decided_at` text,
	FOREIGN KEY (`owner_id`) REFERENCES `principals`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_requests_code_hash_uq` ON `oauth_requests` (`code_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_requests_device_code_uq` ON `oauth_requests` (`device_code_id`);--> statement-breakpoint
CREATE INDEX `oauth_requests_expires_idx` ON `oauth_requests` (`expires_at`);--> statement-breakpoint
ALTER TABLE `agent_tokens` ADD `audience` text;--> statement-breakpoint
ALTER TABLE `agent_tokens` ADD `session_id` text;--> statement-breakpoint
CREATE INDEX `agent_tokens_session_id_idx` ON `agent_tokens` (`session_id`);--> statement-breakpoint
ALTER TABLE `principals` ADD `repo_ids` text;--> statement-breakpoint
ALTER TABLE `principals` ADD `disabled_at` text;