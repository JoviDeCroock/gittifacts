CREATE TABLE `plan_picks` (
	`plan_id` text PRIMARY KEY NOT NULL,
	`change_id` text NOT NULL,
	`picked_by` text NOT NULL,
	`head_sha` text,
	`picked_at` text NOT NULL,
	FOREIGN KEY (`plan_id`) REFERENCES `plans`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`change_id`) REFERENCES `changes`(`id`) ON UPDATE no action ON DELETE cascade
);
