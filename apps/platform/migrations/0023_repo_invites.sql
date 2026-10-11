CREATE TABLE `repo_invites` (
	`id` text PRIMARY KEY NOT NULL,
	`repo_id` text NOT NULL,
	`email` text NOT NULL,
	`role` text NOT NULL,
	`invited_by` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`accepted_at` text,
	`accepted_by` text,
	`revoked_at` text,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `repo_invites_token_hash_unique` ON `repo_invites` (`token_hash`);--> statement-breakpoint
CREATE INDEX `repo_invites_repo_email_idx` ON `repo_invites` (`repo_id`,`email`);