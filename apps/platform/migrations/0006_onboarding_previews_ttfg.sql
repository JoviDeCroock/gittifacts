CREATE TABLE `previews` (
	`id` text PRIMARY KEY NOT NULL,
	`change_id` text NOT NULL,
	`repo_id` text NOT NULL,
	`project_name` text NOT NULL,
	`head_sha` text NOT NULL,
	`artifacts_repo` text NOT NULL,
	`snapshot_id` text NOT NULL,
	`snapshot_step` text NOT NULL,
	`template` text,
	`claimed` integer NOT NULL,
	`status` text NOT NULL,
	`detail` text,
	`created_at` text NOT NULL,
	`ready_at` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `previews_change_created_idx` ON `previews` (`change_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `project_onboarding` (
	`project_id` text PRIMARY KEY NOT NULL,
	`template` text,
	`source` text NOT NULL,
	`principal_id` text NOT NULL,
	`bootstrap_change_id` text,
	`created_at` text NOT NULL,
	`responded_at` text,
	`evidence_at` text,
	`preview_ready_at` text,
	`ci_status` text,
	`preview_status` text,
	`outcome` text,
	`ms_to_respond` integer,
	`ms_to_green` integer,
	`ms_to_preview` integer
);
--> statement-breakpoint
CREATE INDEX `project_onboarding_created_idx` ON `project_onboarding` (`created_at`);