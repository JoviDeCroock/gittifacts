CREATE TABLE `repo_members` (
	`repo_id` text NOT NULL,
	`principal_id` text NOT NULL,
	`role` text NOT NULL,
	`added_by` text NOT NULL,
	`added_at` text NOT NULL,
	PRIMARY KEY(`repo_id`, `principal_id`),
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`principal_id`) REFERENCES `principals`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `repo_members_principal_idx` ON `repo_members` (`principal_id`);--> statement-breakpoint
-- Backfill: every claimed repo's owner becomes its `owner` member. The owner is the claim owner,
-- else (repos from before claims) the human who created it, or the human owning the creating agent.
-- Unclaimed projects get no rows: no human may act on them until someone claims them.
INSERT OR IGNORE INTO `repo_members` (`repo_id`, `principal_id`, `role`, `added_by`, `added_at`)
SELECT r.`id`, h.`id`, 'owner', 'system', r.`created_at`
FROM `repos` r
JOIN `principals` h ON h.`kind` = 'human' AND h.`id` = COALESCE(
  r.`claim_owner_id`,
  (SELECT CASE WHEN c.`kind` = 'human' THEN c.`id` ELSE c.`owner_id` END
     FROM `principals` c WHERE c.`id` = r.`created_by`)
)
WHERE r.`claim_status` = 'claimed';
