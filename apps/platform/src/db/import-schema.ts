/**
 * Import by push (src/import/push-grant.ts): the one-time grant a human owner uses to push a
 * repo's history into an empty project. One row per repo (a re-opened grant replaces it).
 *
 * Only the token's id is stored, never the token: the platform needs it to revoke the token at
 * the first push, the first Change, or the TTL. `status` is `open` → `closing` (revocation not
 * confirmed yet; start_change refuses meanwhile) → `closed`.
 */
import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { repos } from "./app-schema.js";

export const IMPORT_GRANT_STATUSES = ["open", "closing", "closed"] as const;
export const IMPORT_CLOSE_REASONS = [
  "pushed",
  "change-started",
  "expired",
  "closed-by-owner",
] as const;

export const importGrants = sqliteTable(
  "import_grants",
  {
    repoId: text("repo_id")
      .primaryKey()
      .references(() => repos.id, { onDelete: "cascade" }),
    /** The human owner the token was handed to. */
    openedBy: text("opened_by").notNull(),
    /** Artifacts token id (to revoke it); the plaintext is returned once and never stored. */
    tokenId: text("token_id").notNull(),
    status: text("status", { enum: IMPORT_GRANT_STATUSES }).notNull(),
    openedAt: text("opened_at").notNull(),
    /** The token's expiry: the grant closes by itself then. */
    openUntil: text("open_until").notNull(),
    closeReason: text("close_reason", { enum: IMPORT_CLOSE_REASONS }),
    closedAt: text("closed_at"),
    /** The default branch's head when the grant closed (null: nothing was pushed to it). */
    mainSha: text("main_sha"),
  },
  (t) => [index("import_grants_status_idx").on(t.status, t.openUntil)],
);
