-- Hand-edited (drizzle-kit table rebuild): D1 can't honor PRAGMA foreign_keys=OFF, so defer instead
-- (docs/research/stack.md §1); existing rows belong to the "global" log.
PRAGMA defer_foreign_keys = on;--> statement-breakpoint
CREATE TABLE `__new_audit_events` (
	`log` text DEFAULT 'global' NOT NULL,
	`seq` integer NOT NULL,
	`at` text NOT NULL,
	`principal_id` text NOT NULL,
	`action` text NOT NULL,
	`subject` text NOT NULL,
	`payload_hash` text NOT NULL,
	`prev_hash` text NOT NULL,
	`hash` text NOT NULL,
	`signature` text NOT NULL,
	`key_id` text NOT NULL,
	`payload` text,
	PRIMARY KEY(`log`, `seq`)
);
--> statement-breakpoint
INSERT INTO `__new_audit_events`("log", "seq", "at", "principal_id", "action", "subject", "payload_hash", "prev_hash", "hash", "signature", "key_id", "payload") SELECT 'global', "seq", "at", "principal_id", "action", "subject", "payload_hash", "prev_hash", "hash", "signature", "key_id", "payload" FROM `audit_events`;--> statement-breakpoint
DROP TABLE `audit_events`;--> statement-breakpoint
ALTER TABLE `__new_audit_events` RENAME TO `audit_events`;--> statement-breakpoint
PRAGMA defer_foreign_keys = off;--> statement-breakpoint
CREATE INDEX `audit_events_subject_seq_idx` ON `audit_events` (`log`,`subject`,`seq`);--> statement-breakpoint
CREATE INDEX `audit_events_principal_seq_idx` ON `audit_events` (`log`,`principal_id`,`seq`);
