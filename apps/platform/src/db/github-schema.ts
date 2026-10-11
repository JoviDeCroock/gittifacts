/**
 * GitHub mode (docs/prompts/06-two-modes.md §3, docs/research/github-app.md §7):
 *
 * - Our GitHub Apps live in Worker config, not here (src/github/app-config.ts; migration 0016
 *   dropped the old `github_apps` / `github_states` tables of the removed manifest flow).
 * - `github_deliveries`: webhook delivery GUIDs seen (`X-GitHub-Delivery`), kept ≥ 7 days to
 *   drop redeliveries.
 * - `github_installations` / `github_installation_repos`: installations of our Apps and the repos
 *   they cover, kept in sync from `installation*` webhooks and the setup flow.
 * - `github_installation_links`: which platform humans proved (with a GitHub user token) that they
 *   can access an installation. Never from `installation_id` alone.
 * - `github_link_repos`: per link, the repos that token could see and its access to each.
 */
import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
    /** The GitHub login whose user token proved it (display only: logins are renamable). */
    githubLogin: text("github_login").notNull(),
    /**
     * GitHub's numeric user id behind that token: who this human is on GitHub (author checks,
     * attribution). Null on links made before migration 0024: such a link attributes nothing
     * and counts as "may be the author" until it is linked again.
     */
    githubUserId: integer("github_user_id"),
    linkedAt: text("linked_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.installationId, t.principalId] }),
    index("github_installation_links_principal_idx").on(t.principalId),
    index("github_installation_links_user_idx").on(t.githubUserId),
  ],
);

/**
 * The repos of an installation each link's user token could see, and with what access (from
 * `GET /user/installations/{id}/repositories` at link time). Memberships come from these rows
 * only, per repo: a link never grants a repo its user couldn't see on GitHub. "admin": admin on
 * the repo, or the installation's personal account itself; "write": maintain or push; "read":
 * anything less. Replaced on every link; rows go when the repo leaves the installation.
 */
export const githubLinkRepos = sqliteTable(
  "github_link_repos",
  {
    installationId: integer("installation_id").notNull(),
    principalId: text("principal_id").notNull(),
    /** GitHub's repository id. */
    repoId: integer("repo_id").notNull(),
    access: text("access", { enum: ["admin", "write", "read"] }).notNull(),
    recordedAt: text("recorded_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.installationId, t.principalId, t.repoId] }),
    index("github_link_repos_repo_idx").on(t.installationId, t.repoId),
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

/** M3: the tour review gittifacts posted for each (Change, head), and its inline comment ids. */
export const githubPrReviews = sqliteTable(
  "github_pr_reviews",
  {
    changeId: text("change_id").notNull(),
    headSha: text("head_sha").notNull(),
    reviewId: integer("review_id").notNull(),
    nodeId: text("node_id").notNull(),
    commentIds: text("comment_ids", { mode: "json" }).$type<number[]>().notNull(),
    staleAt: text("stale_at"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.changeId, t.headSha] })],
);

/** M3: the one summary comment per PR (edited only when its text hash changes). */
export const githubPrSummaries = sqliteTable("github_pr_summaries", {
  changeId: text("change_id").primaryKey(),
  commentId: integer("comment_id").notNull(),
  bodyHash: text("body_hash").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/** M3: "Request full review" presses on a head's check run. */
export const githubFullReviews = sqliteTable(
  "github_full_reviews",
  {
    changeId: text("change_id").notNull(),
    headSha: text("head_sha").notNull(),
    login: text("login").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.changeId, t.headSha, t.login] })],
);

/** M3: per-repo switch for PR writes beyond the check run (on unless an owner turned it off). */
export const githubRepoSettings = sqliteTable("github_repo_settings", {
  repoId: text("repo_id").primaryKey(),
  prWrites: text("pr_writes", { enum: ["on", "off"] }).notNull(),
  updatedBy: text("updated_by").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/**
 * M4: backtests of a GitHub repo's merged PRs (spec §3.7) and the per-repo calibration they
 * yield. The latest finished one decides whether Lane 0 may be turned on for the repo.
 */
export const githubBacktests = sqliteTable(
  "github_backtests",
  {
    id: text("id").primaryKey(),
    /** The platform repo (`gh-<id>`); may be created by the backtest itself. */
    repoId: text("repo_id").notNull(),
    githubRepoId: integer("github_repo_id").notNull(),
    installationId: integer("installation_id").notNull(),
    status: text("status", { enum: ["running", "done", "failed"] }).notNull(),
    since: text("since").notNull(),
    until: text("until").notNull(),
    maxPrs: integer("max_prs").notNull(),
    report: text("report", { mode: "json" }).$type<unknown>(),
    eligible: integer("eligible", { mode: "boolean" }),
    error: text("error"),
    startedBy: text("started_by").notNull(),
    createdAt: text("created_at").notNull(),
    finishedAt: text("finished_at"),
  },
  (t) => [index("github_backtests_repo_idx").on(t.repoId, t.createdAt)],
);
