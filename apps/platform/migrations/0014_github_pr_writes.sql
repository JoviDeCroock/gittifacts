CREATE TABLE `github_full_reviews` (
	`change_id` text NOT NULL,
	`head_sha` text NOT NULL,
	`login` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`change_id`, `head_sha`, `login`)
);
--> statement-breakpoint
CREATE TABLE `github_pr_reviews` (
	`change_id` text NOT NULL,
	`head_sha` text NOT NULL,
	`review_id` integer NOT NULL,
	`node_id` text NOT NULL,
	`comment_ids` text NOT NULL,
	`stale_at` text,
	`created_at` text NOT NULL,
	PRIMARY KEY(`change_id`, `head_sha`)
);
--> statement-breakpoint
CREATE TABLE `github_pr_summaries` (
	`change_id` text PRIMARY KEY NOT NULL,
	`comment_id` integer NOT NULL,
	`body_hash` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `github_repo_settings` (
	`repo_id` text PRIMARY KEY NOT NULL,
	`pr_writes` text NOT NULL,
	`updated_by` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `reviews` ADD `source` text;