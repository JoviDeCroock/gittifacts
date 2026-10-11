-- GitHub links (security audit 2026-10-11, H1 + M4; DECISIONS 2026-10-11): a link records the
-- GitHub user id behind the token (author checks and attribution compare ids, never logins), and
-- the repos that token could see with its access to each (memberships are granted per repo from
-- these rows only). Links made before this migration have no id: they attribute nothing and count
-- as "may be the author" until linked again.
CREATE TABLE `github_link_repos` (
	`installation_id` integer NOT NULL,
	`principal_id` text NOT NULL,
	`repo_id` integer NOT NULL,
	`access` text NOT NULL,
	`recorded_at` text NOT NULL,
	PRIMARY KEY(`installation_id`, `principal_id`, `repo_id`)
);
--> statement-breakpoint
CREATE INDEX `github_link_repos_repo_idx` ON `github_link_repos` (`installation_id`,`repo_id`);--> statement-breakpoint
ALTER TABLE `github_installation_links` ADD `github_user_id` integer;--> statement-breakpoint
CREATE INDEX `github_installation_links_user_idx` ON `github_installation_links` (`github_user_id`);
