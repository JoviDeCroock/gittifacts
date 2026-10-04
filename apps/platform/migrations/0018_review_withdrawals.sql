ALTER TABLE `reviews` ADD `withdrawn_at` text;--> statement-breakpoint
ALTER TABLE `reviews` ADD `withdrawn_reason` text;--> statement-breakpoint
ALTER TABLE `reviews` ADD `withdrawn_by` text;--> statement-breakpoint
ALTER TABLE `qa_runs` ADD `withdrawn` text;