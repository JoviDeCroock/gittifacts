CREATE TABLE `agent_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`principal_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`prefix` text NOT NULL,
	`scopes` text NOT NULL,
	`created_by` text,
	`created_at` text NOT NULL,
	`expires_at` text,
	`last_used_at` text,
	`revoked_at` text,
	FOREIGN KEY (`principal_id`) REFERENCES `principals`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `principals`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_tokens_token_hash_uq` ON `agent_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `agent_tokens_principal_id_idx` ON `agent_tokens` (`principal_id`);--> statement-breakpoint
CREATE TABLE `audit_events` (
	`seq` integer PRIMARY KEY NOT NULL,
	`at` text NOT NULL,
	`principal_id` text NOT NULL,
	`action` text NOT NULL,
	`subject` text NOT NULL,
	`payload_hash` text NOT NULL,
	`prev_hash` text NOT NULL,
	`hash` text NOT NULL,
	`signature` text NOT NULL,
	`key_id` text NOT NULL,
	`payload` text
);
--> statement-breakpoint
CREATE INDEX `audit_events_subject_seq_idx` ON `audit_events` (`subject`,`seq`);--> statement-breakpoint
CREATE INDEX `audit_events_principal_seq_idx` ON `audit_events` (`principal_id`,`seq`);--> statement-breakpoint
CREATE TABLE `changes` (
	`id` text PRIMARY KEY NOT NULL,
	`repo_id` text NOT NULL,
	`plan_id` text,
	`title` text NOT NULL,
	`claim_category` text NOT NULL,
	`claim_summary` text,
	`base_sha` text NOT NULL,
	`head_sha` text,
	`fork_name` text NOT NULL,
	`author_id` text NOT NULL,
	`status` text NOT NULL,
	`computed_lane` integer,
	`lane` integer,
	`lane_reasons` text NOT NULL,
	`evidence_id` text,
	`tour_id` text,
	`flag_key` text,
	`merged_sha` text,
	`rollout_state` text,
	`rollout_version_id` text,
	`revert_of` text,
	`reverted_by` text,
	`agent_trace_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`plan_id`) REFERENCES `plans`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`author_id`) REFERENCES `principals`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `changes_fork_name_uq` ON `changes` (`fork_name`);--> statement-breakpoint
CREATE INDEX `changes_repo_status_idx` ON `changes` (`repo_id`,`status`);--> statement-breakpoint
CREATE INDEX `changes_repo_updated_idx` ON `changes` (`repo_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `changes_plan_id_idx` ON `changes` (`plan_id`);--> statement-breakpoint
CREATE INDEX `changes_author_id_idx` ON `changes` (`author_id`);--> statement-breakpoint
CREATE INDEX `changes_rollout_version_idx` ON `changes` (`rollout_version_id`);--> statement-breakpoint
CREATE INDEX `changes_revert_of_idx` ON `changes` (`revert_of`);--> statement-breakpoint
CREATE TABLE `classifications` (
	`change_id` text NOT NULL,
	`head_sha` text NOT NULL,
	`lane` integer NOT NULL,
	`computed_lane` integer NOT NULL,
	`shadow` integer NOT NULL,
	`blocked` integer NOT NULL,
	`requires_human_approval` integer NOT NULL,
	`json` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`change_id`, `head_sha`),
	FOREIGN KEY (`change_id`) REFERENCES `changes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `diffs` (
	`change_id` text NOT NULL,
	`head_sha` text NOT NULL,
	`base_sha` text NOT NULL,
	`json` text,
	`r2_key` text,
	`size_bytes` integer NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`change_id`, `head_sha`),
	FOREIGN KEY (`change_id`) REFERENCES `changes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `evidence` (
	`id` text PRIMARY KEY NOT NULL,
	`change_id` text NOT NULL,
	`head_sha` text NOT NULL,
	`base_sha` text NOT NULL,
	`key_id` text NOT NULL,
	`notes_written` integer NOT NULL,
	`json` text,
	`r2_key` text,
	`size_bytes` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`change_id`) REFERENCES `changes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `evidence_change_head_uq` ON `evidence` (`change_id`,`head_sha`);--> statement-breakpoint
CREATE TABLE `issues` (
	`id` text PRIMARY KEY NOT NULL,
	`change_id` text,
	`script_name` text NOT NULL,
	`title` text NOT NULL,
	`count` integer NOT NULL,
	`first_seen` text NOT NULL,
	`last_seen` text NOT NULL,
	`version_id` text,
	`url` text,
	`raw` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`change_id`) REFERENCES `changes`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `issues_version_id_idx` ON `issues` (`version_id`,`last_seen`);--> statement-breakpoint
CREATE INDEX `issues_change_id_idx` ON `issues` (`change_id`,`last_seen`);--> statement-breakpoint
CREATE INDEX `issues_last_seen_idx` ON `issues` (`last_seen`);--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`change_id` text,
	`repo_id` text,
	`message` text NOT NULL,
	`created_at` text NOT NULL,
	`read_at` text
);
--> statement-breakpoint
CREATE INDEX `notifications_change_id_idx` ON `notifications` (`change_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `notifications_created_at_idx` ON `notifications` (`created_at`);--> statement-breakpoint
CREATE TABLE `pipeline_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`change_id` text NOT NULL,
	`head_sha` text NOT NULL,
	`engine` text NOT NULL,
	`status` text NOT NULL,
	`started_at` text,
	`finished_at` text,
	`steps` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`change_id`) REFERENCES `changes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `pipeline_runs_change_head_idx` ON `pipeline_runs` (`change_id`,`head_sha`);--> statement-breakpoint
CREATE TABLE `plans` (
	`id` text PRIMARY KEY NOT NULL,
	`repo_id` text NOT NULL,
	`title` text NOT NULL,
	`intent` text NOT NULL,
	`acceptance_criteria` text NOT NULL,
	`out_of_scope` text NOT NULL,
	`risk_declarations` text NOT NULL,
	`scope_paths` text NOT NULL,
	`affected_routes` text NOT NULL,
	`status` text NOT NULL,
	`author_id` text NOT NULL,
	`approved_by` text,
	`approved_at` text,
	`approval_signature` text,
	`approval_key_id` text,
	`supersedes` text,
	`decision_comment` text,
	`decided_by` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_id`) REFERENCES `principals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`approved_by`) REFERENCES `principals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`supersedes`) REFERENCES `plans`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `plans_repo_created_idx` ON `plans` (`repo_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `plans_author_id_idx` ON `plans` (`author_id`);--> statement-breakpoint
CREATE INDEX `plans_supersedes_idx` ON `plans` (`supersedes`);--> statement-breakpoint
CREATE TABLE `principal_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`principal_id` text NOT NULL,
	`alg` text NOT NULL,
	`public_key` text NOT NULL,
	`created_at` text NOT NULL,
	`revoked_at` text,
	FOREIGN KEY (`principal_id`) REFERENCES `principals`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `principal_keys_principal_id_idx` ON `principal_keys` (`principal_id`);--> statement-breakpoint
CREATE TABLE `principals` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`owner_id` text,
	`user_id` text,
	`scopes` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `principals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `principals_user_id_uq` ON `principals` (`user_id`);--> statement-breakpoint
CREATE INDEX `principals_owner_id_idx` ON `principals` (`owner_id`);--> statement-breakpoint
CREATE TABLE `repos` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace` text NOT NULL,
	`artifacts_name` text NOT NULL,
	`name` text NOT NULL,
	`default_branch` text DEFAULT 'main' NOT NULL,
	`jurisdiction` text NOT NULL,
	`imported_from` text,
	`policy` text NOT NULL,
	`policy_sha` text,
	`deploy_target` text,
	`created_by` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `repos_artifacts_name_uq` ON `repos` (`artifacts_name`);--> statement-breakpoint
CREATE UNIQUE INDEX `repos_namespace_name_uq` ON `repos` (`namespace`,`name`);--> statement-breakpoint
CREATE TABLE `reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`change_id` text NOT NULL,
	`head_sha` text NOT NULL,
	`reviewer_id` text NOT NULL,
	`decision` text NOT NULL,
	`human_lane` integer,
	`computed_lane` integer NOT NULL,
	`comment` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`change_id`) REFERENCES `changes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`reviewer_id`) REFERENCES `principals`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `reviews_change_id_idx` ON `reviews` (`change_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `reviews_computed_lane_idx` ON `reviews` (`computed_lane`);--> statement-breakpoint
CREATE TABLE `tours` (
	`id` text PRIMARY KEY NOT NULL,
	`change_id` text NOT NULL,
	`head_sha` text NOT NULL,
	`json` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`change_id`) REFERENCES `changes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `tours_change_head_idx` ON `tours` (`change_id`,`head_sha`,`created_at`);--> statement-breakpoint
CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `account_userId_idx` ON `account` (`user_id`);--> statement-breakpoint
CREATE TABLE `passkey` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`public_key` text NOT NULL,
	`user_id` text NOT NULL,
	`credential_id` text NOT NULL,
	`counter` integer NOT NULL,
	`device_type` text NOT NULL,
	`backed_up` integer NOT NULL,
	`transports` text,
	`created_at` integer,
	`aaguid` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `passkey_userId_idx` ON `passkey` (`user_id`);--> statement-breakpoint
CREATE INDEX `passkey_credentialID_idx` ON `passkey` (`credential_id`);--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE INDEX `session_userId_idx` ON `session` (`user_id`);--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);--> statement-breakpoint
CREATE VIEW `shadow_samples` AS select "reviews"."id" as "review_id", "changes"."repo_id" as "repo_id", "reviews"."change_id" as "change_id", "reviews"."head_sha" as "head_sha", "reviews"."computed_lane" as "computed_lane", "reviews"."human_lane" as "human_lane", "reviews"."decision" as "decision", "reviews"."created_at" as "created_at" from "reviews" inner join "changes" on "changes"."id" = "reviews"."change_id";