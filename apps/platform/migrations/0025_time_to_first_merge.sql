-- Onboarding's golden path (DECISIONS 2026-10-11): the sample Plan create_project drafts for a
-- template repo, and time-to-first-merge (create_project → the first non-bootstrap Change landed).
ALTER TABLE `project_onboarding` ADD `sample_plan_id` text;--> statement-breakpoint
ALTER TABLE `project_onboarding` ADD `first_merge_change_id` text;--> statement-breakpoint
ALTER TABLE `project_onboarding` ADD `first_merged_at` text;--> statement-breakpoint
ALTER TABLE `project_onboarding` ADD `ms_to_first_merge` integer;
