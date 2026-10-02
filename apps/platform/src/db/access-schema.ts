/**
 * Repo membership (basic access control, apps/platform/src/access/).
 *
 * One row per (repo, human principal) with a role: `owner` > `maintainer` > `reviewer` > `reader`.
 * Agents and integrations are never members: their access derives from their owning human's row
 * (src/access/roles.ts). The creator of a claimed repo, and whoever claims an unclaimed project,
 * gets an `owner` row (D1Store.insertRepo/updateRepo keep that in step with `repos.claim_owner_id`).
 */
import { index, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { principals, repos } from "./app-schema.js";

export const REPO_ROLES = ["owner", "maintainer", "reviewer", "reader"] as const;

export const repoMembers = sqliteTable(
  "repo_members",
  {
    repoId: text("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    principalId: text("principal_id")
      .notNull()
      .references(() => principals.id, { onDelete: "cascade" }),
    role: text("role", { enum: REPO_ROLES }).notNull(),
    /** Principal that added (or last changed) the membership; `system` for backfills and claims. */
    addedBy: text("added_by").notNull(),
    addedAt: text("added_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.repoId, t.principalId] }),
    index("repo_members_principal_idx").on(t.principalId),
  ],
);
