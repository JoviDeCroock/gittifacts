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

/**
 * Pending invites (src/access/invites.ts): an owner adds an e-mail nobody has signed up with yet.
 * The invite link (`/invite/gtm_…`) is shown once; only its SHA-256 is stored. Accepting needs the
 * link AND a signed-in person whose e-mail is `email` (DECISIONS 2026-10-11). One pending invite
 * per (repo, e-mail): inviting again replaces the link. Single use: `accepted_at` is set once.
 */
export const repoInvites = sqliteTable(
  "repo_invites",
  {
    id: text("id").primaryKey(),
    repoId: text("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    /** Trimmed and lower-cased. */
    email: text("email").notNull(),
    role: text("role", { enum: REPO_ROLES }).notNull(),
    invitedBy: text("invited_by").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    acceptedAt: text("accepted_at"),
    acceptedBy: text("accepted_by"),
    revokedAt: text("revoked_at"),
  },
  (t) => [index("repo_invites_repo_email_idx").on(t.repoId, t.email)],
);
