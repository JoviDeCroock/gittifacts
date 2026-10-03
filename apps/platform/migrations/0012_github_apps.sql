CREATE TABLE `github_apps` (
	`id` integer PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`owner_login` text NOT NULL,
	`owner_type` text NOT NULL,
	`client_id` text NOT NULL,
	`html_url` text NOT NULL,
	`client_secret_enc` text NOT NULL,
	`webhook_secret_enc` text NOT NULL,
	`pem_enc` text NOT NULL,
	`permissions` text NOT NULL,
	`events` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `github_apps_slug_unique` ON `github_apps` (`slug`);--> statement-breakpoint
CREATE INDEX `github_apps_kind_idx` ON `github_apps` (`kind`);--> statement-breakpoint
CREATE TABLE `github_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` integer NOT NULL,
	`event` text NOT NULL,
	`action` text,
	`installation_id` integer,
	`received_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `github_deliveries_received_idx` ON `github_deliveries` (`received_at`);--> statement-breakpoint
CREATE TABLE `github_installation_links` (
	`installation_id` integer NOT NULL,
	`principal_id` text NOT NULL,
	`github_login` text NOT NULL,
	`linked_at` text NOT NULL,
	PRIMARY KEY(`installation_id`, `principal_id`)
);
--> statement-breakpoint
CREATE INDEX `github_installation_links_principal_idx` ON `github_installation_links` (`principal_id`);--> statement-breakpoint
CREATE TABLE `github_installation_repos` (
	`installation_id` integer NOT NULL,
	`repo_id` integer NOT NULL,
	`full_name` text NOT NULL,
	`private` integer NOT NULL,
	`added_at` text NOT NULL,
	PRIMARY KEY(`installation_id`, `repo_id`)
);
--> statement-breakpoint
CREATE INDEX `github_installation_repos_name_idx` ON `github_installation_repos` (`full_name`);--> statement-breakpoint
CREATE TABLE `github_installations` (
	`id` integer PRIMARY KEY NOT NULL,
	`app_id` integer NOT NULL,
	`account_login` text NOT NULL,
	`account_id` integer NOT NULL,
	`account_type` text NOT NULL,
	`repository_selection` text NOT NULL,
	`permissions` text NOT NULL,
	`events` text NOT NULL,
	`suspended_at` text,
	`deleted_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `github_installations_app_idx` ON `github_installations` (`app_id`);--> statement-breakpoint
CREATE TABLE `github_states` (
	`id` text PRIMARY KEY NOT NULL,
	`purpose` text NOT NULL,
	`principal_id` text NOT NULL,
	`data` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`consumed_at` text
);
--> statement-breakpoint
CREATE INDEX `github_states_expires_idx` ON `github_states` (`expires_at`);