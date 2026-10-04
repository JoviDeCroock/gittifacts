CREATE TABLE `qa_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`change_id` text NOT NULL,
	`repo_id` text NOT NULL,
	`head_sha` text NOT NULL,
	`status` text NOT NULL,
	`trigger` text NOT NULL,
	`requested_by` text NOT NULL,
	`requested_login` text,
	`progress` text,
	`item` text,
	`passed` integer,
	`failed` integer,
	`couldnt_test` integer,
	`lane_before` integer,
	`lane_after` integer,
	`cost_usd` real,
	`wall_ms` integer,
	`error` text,
	`created_at` text NOT NULL,
	`started_at` text,
	`finished_at` text
);
--> statement-breakpoint
CREATE INDEX `qa_runs_change_idx` ON `qa_runs` (`change_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `qa_runs_repo_idx` ON `qa_runs` (`repo_id`,`created_at`);