-- Each project with a deploy target gets its own Flagship app (cross-tenant flag isolation). Existing
-- deploy targets get theirs lazily on their next deploy. Unique: two projects never share an app.
ALTER TABLE `repos` ADD `flagship_app_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `repos_flagship_app_uq` ON `repos` (`flagship_app_id`);
