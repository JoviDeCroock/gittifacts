/**
 * GitHub mode (docs/prompts/06-two-modes.md §3, docs/research/github-app.md §7):
 *
 * - `github_apps`: the GitHub Apps the platform created through the manifest flow. One public
 *   Reader App (shadow grading) and, from M5, private per-customer Actor Apps. The client secret,
 *   webhook secret and private key (PEM) are AES-256-GCM sealed under the `GITHUB_APP_KEK` Worker
 *   secret (src/github/crypto.ts), each bound to its App id and field.
 * - `github_states`: signed, single-use `state` values (manifest flow, install verification),
 *   valid for one hour.
 * - `github_deliveries`: webhook delivery GUIDs seen (`X-GitHub-Delivery`), kept ≥ 7 days to
 *   drop redeliveries.
 * - `github_installations` / `github_installation_repos`: installations of our Apps and the repos
 *   they cover, kept in sync from `installation*` webhooks and the setup flow.
 * - `github_installation_links`: which platform humans proved (with a GitHub user token) that they
 *   can access an installation. Never from `installation_id` alone.
 */
import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const GITHUB_APP_KINDS = ["reader", "actor"] as const;
export const GITHUB_STATE_PURPOSES = ["manifest", "install"] as const;

export const githubApps = sqliteTable(
  "github_apps",
  {
    /** GitHub's App id (`X-GitHub-Hook-Installation-Target-ID`). */
    id: integer("id").primaryKey(),
    kind: text("kind", { enum: GITHUB_APP_KINDS }).notNull(),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    ownerLogin: text("owner_login").notNull(),
    ownerType: text("owner_type").notNull(),
    clientId: text("client_id").notNull(),
    htmlUrl: text("html_url").notNull(),
    /** `v1.<iv>.<ct>` (src/github/crypto.ts), never plaintext. */
    clientSecretEnc: text("client_secret_enc").notNull(),
    webhookSecretEnc: text("webhook_secret_enc").notNull(),
    pemEnc: text("pem_enc").notNull(),
    permissions: text("permissions", { mode: "json" }).$type<Record<string, string>>().notNull(),
    events: text("events", { mode: "json" }).$type<string[]>().notNull(),
    /** The platform admin (human principal) who created it. */
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("github_apps_kind_idx").on(t.kind)],
);

export const githubStates = sqliteTable(
  "github_states",
  {
    /** Random nonce; the signed state is `<id>.<mac>`. */
    id: text("id").primaryKey(),
    purpose: text("purpose", { enum: GITHUB_STATE_PURPOSES }).notNull(),
    principalId: text("principal_id").notNull(),
    data: text("data", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    consumedAt: text("consumed_at"),
  },
  (t) => [index("github_states_expires_idx").on(t.expiresAt)],
);

export const githubDeliveries = sqliteTable(
  "github_deliveries",
  {
    /** `X-GitHub-Delivery` (the same on a redelivery). */
    id: text("id").primaryKey(),
    appId: integer("app_id").notNull(),
    event: text("event").notNull(),
    action: text("action"),
    installationId: integer("installation_id"),
    receivedAt: text("received_at").notNull(),
  },
  (t) => [index("github_deliveries_received_idx").on(t.receivedAt)],
);

export const githubInstallations = sqliteTable(
  "github_installations",
  {
    id: integer("id").primaryKey(),
    appId: integer("app_id").notNull(),
    accountLogin: text("account_login").notNull(),
    accountId: integer("account_id").notNull(),
    /** "User" | "Organization" (GitHub's account type). */
    accountType: text("account_type").notNull(),
    /** "all" | "selected". */
    repositorySelection: text("repository_selection").notNull(),
    permissions: text("permissions", { mode: "json" }).$type<Record<string, string>>().notNull(),
    events: text("events", { mode: "json" }).$type<string[]>().notNull(),
    suspendedAt: text("suspended_at"),
    deletedAt: text("deleted_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("github_installations_app_idx").on(t.appId)],
);

export const githubInstallationRepos = sqliteTable(
  "github_installation_repos",
  {
    installationId: integer("installation_id").notNull(),
    /** GitHub's repository id. */
    repoId: integer("repo_id").notNull(),
    fullName: text("full_name").notNull(),
    private: integer("private", { mode: "boolean" }).notNull(),
    addedAt: text("added_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.installationId, t.repoId] }),
    index("github_installation_repos_name_idx").on(t.fullName),
  ],
);

export const githubInstallationLinks = sqliteTable(
  "github_installation_links",
  {
    installationId: integer("installation_id").notNull(),
    /** The platform human who proved access. */
    principalId: text("principal_id").notNull(),
    /** The GitHub login whose user token proved it. */
    githubLogin: text("github_login").notNull(),
    linkedAt: text("linked_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.installationId, t.principalId] }),
    index("github_installation_links_principal_idx").on(t.principalId),
  ],
);

/** The `gittifacts/lane` check run of each (Change, head): created when grading starts, completed once. */
export const githubCheckRuns = sqliteTable(
  "github_check_runs",
  {
    changeId: text("change_id").notNull(),
    headSha: text("head_sha").notNull(),
    checkRunId: integer("check_run_id").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.changeId, t.headSha] })],
);
