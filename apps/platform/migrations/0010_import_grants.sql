CREATE TABLE `import_grants` (
	`repo_id` text PRIMARY KEY NOT NULL,
	`opened_by` text NOT NULL,
	`token_id` text NOT NULL,
	`status` text NOT NULL,
	`opened_at` text NOT NULL,
	`open_until` text NOT NULL,
	`close_reason` text,
	`closed_at` text,
	`main_sha` text,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `import_grants_status_idx` ON `import_grants` (`status`,`open_until`);