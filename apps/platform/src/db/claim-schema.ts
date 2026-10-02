/**
 * Claimable projects and abuse limits (docs/prompts/02-onboarding.md §4, O3).
 *
 * - `project_claims`: one row per unclaimed project (= repo): the agent principal created for it,
 *   the SHA-256 of its single-use claim token, who created it (hashed IP, ASN) and its lifecycle.
 *   The row outlives the project as a tombstone after expiry (ids and timestamps only), so a
 *   claim link says "expired" instead of "unknown" and per-IP aggregates keep counting.
 * - `unclaimed_creations`: idempotency for credential-less `create_project` (there is no principal
 *   to key `idempotency_keys` on): SHA-256 of the key → the principal and repo it created.
 * - `platform_settings`: small admin overrides that must work when Flagship is unreachable
 *   (the unclaimed-creation kill switch).
 */
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const projectClaims = sqliteTable(
  "project_claims",
  {
    repoId: text("repo_id").primaryKey(),
    /** The unclaimed agent principal that owns the project's token. */
    agentPrincipalId: text("agent_principal_id").notNull(),
    /** hex SHA-256 of the claim token (`gtc_…`); the plaintext is only in the claimUrl. */
    claimTokenHash: text("claim_token_hash").notNull(),
    /** hex SHA-256 (salted) of the creator's IP (/64 for IPv6); never the raw address. */
    creatorIpHash: text("creator_ip_hash").notNull(),
    creatorAsn: integer("creator_asn"),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    status: text("status", { enum: ["unclaimed", "claimed", "expiring", "expired"] }).notNull(),
    claimedAt: text("claimed_at"),
    /** Human principal who claimed it. */
    claimedBy: text("claimed_by"),
    expiredAt: text("expired_at"),
    /** Project name, kept for the tombstone (the repo row is deleted on expiry). */
    projectName: text("project_name").notNull(),
  },
  (t) => [
    uniqueIndex("project_claims_token_uq").on(t.claimTokenHash),
    index("project_claims_status_expiry_idx").on(t.status, t.expiresAt),
    index("project_claims_ip_idx").on(t.creatorIpHash, t.createdAt),
    index("project_claims_agent_idx").on(t.agentPrincipalId),
  ],
);

export const unclaimedCreations = sqliteTable(
  "unclaimed_creations",
  {
    /** hex SHA-256 of `anon:<Idempotency-Key>`. */
    keyHash: text("key_hash").primaryKey(),
    /** hex SHA-256 of the request body, so a key can't be replayed for another request. */
    requestHash: text("request_hash").notNull(),
    principalId: text("principal_id").notNull(),
    /** Null while the first request is still creating the project. */
    repoId: text("repo_id"),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at").notNull(),
  },
  (t) => [index("unclaimed_creations_expires_idx").on(t.expiresAt)],
);

export const platformSettings = sqliteTable("platform_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull(),
  updatedBy: text("updated_by").notNull(),
});
