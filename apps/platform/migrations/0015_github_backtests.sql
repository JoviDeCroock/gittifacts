CREATE TABLE `github_backtests` (
	`id` text PRIMARY KEY NOT NULL,
	`repo_id` text NOT NULL,
	`github_repo_id` integer NOT NULL,
	`installation_id` integer NOT NULL,
	`status` text NOT NULL,
	`since` text NOT NULL,
	`until` text NOT NULL,
	`max_prs` integer NOT NULL,
	`report` text,
	`eligible` integer,
	`error` text,
	`started_by` text NOT NULL,
	`created_at` text NOT NULL,
	`finished_at` text
);
--> statement-breakpoint
CREATE INDEX `github_backtests_repo_idx` ON `github_backtests` (`repo_id`,`created_at`);