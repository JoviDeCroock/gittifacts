CREATE TABLE `github_check_runs` (
	`change_id` text NOT NULL,
	`head_sha` text NOT NULL,
	`check_run_id` integer NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`change_id`, `head_sha`)
);
--> statement-breakpoint
DROP INDEX `changes_fork_name_uq`;--> statement-breakpoint
ALTER TABLE `changes` ADD `host` text;--> statement-breakpoint
CREATE UNIQUE INDEX `changes_fork_name_uq` ON `changes` (`fork_name`) WHERE "changes"."fork_name" LIKE 'task-%';--> statement-breakpoint
ALTER TABLE `repos` ADD `host` text;