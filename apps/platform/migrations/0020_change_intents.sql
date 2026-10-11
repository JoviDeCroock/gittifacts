CREATE TABLE `change_intents` (
	`change_id` text PRIMARY KEY NOT NULL,
	`paths` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`change_id`) REFERENCES `changes`(`id`) ON UPDATE no action ON DELETE cascade
);
