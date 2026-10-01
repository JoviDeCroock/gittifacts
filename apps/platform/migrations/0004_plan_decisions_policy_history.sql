CREATE TABLE `repo_policies` (
	`repo_id` text NOT NULL,
	`sha` text NOT NULL,
	`policy` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`repo_id`, `sha`),
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `plans` ADD `decided_at` text;--> statement-breakpoint
INSERT OR IGNORE INTO `repo_policies` (`repo_id`, `sha`, `policy`, `created_at`)
SELECT `id`, `policy_sha`, `policy`, `created_at` FROM `repos` WHERE `policy_sha` IS NOT NULL;
--> statement-breakpoint
UPDATE `plans` SET `decided_at` = `updated_at` WHERE `decided_by` IS NOT NULL AND `decided_at` IS NULL;
