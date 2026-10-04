CREATE TABLE `qa_refusals` (
	`id` text PRIMARY KEY NOT NULL,
	`change_id` text NOT NULL,
	`head_sha` text NOT NULL,
	`reason` text NOT NULL,
	`login` text,
	`via` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `qa_refusals_change_idx` ON `qa_refusals` (`change_id`,`created_at`);