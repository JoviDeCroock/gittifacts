-- The platform's own principal (SYSTEM_PRINCIPAL_ID in @app/coordinator): authors revert changes,
-- signs machine actions in the audit log. No scopes: it never calls the public API.
INSERT OR IGNORE INTO `principals` (`id`, `kind`, `name`, `owner_id`, `user_id`, `scopes`, `created_at`)
VALUES ('system', 'system', 'gittifacts', NULL, NULL, '[]', '2026-10-01T00:00:00.000Z');
