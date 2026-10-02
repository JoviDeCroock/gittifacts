/**
 * Platform tables (D1, Drizzle sqlite-core). better-auth's tables live in ./auth-schema.ts (generated).
 *
 * Conventions:
 * - Timestamps are ISO-8601 UTC strings (`Date#toISOString()`), so they sort lexicographically and
 *   map 1:1 onto the domain's `IsoDate`.
 * - Structured fields are `text({ mode: "json" })` (SQLite JSON functions work on them). Rows are
 *   zod-parsed back into domain types at the Store boundary (src/store/rows.ts), never trusted as-is.
 * - Large JSON documents (diffs, evidence) go to R2 when they exceed 512 KB; the row keeps `r2_key`.
 */
import { eq, sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  index,
  integer,
  primaryKey,
  sqliteTable,
  sqliteView,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { user } from "./auth-schema.js";

// ---------------------------------------------------------------- identity

export const principals = sqliteTable(
  "principals",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ["human", "agent", "system", "integration"] }).notNull(),
    name: text("name").notNull(),
    /** Agents: the human principal accountable for it. */
    ownerId: text("owner_id").references((): AnySQLiteColumn => principals.id),
    /** Humans: the better-auth user behind this principal. */
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    scopes: text("scopes", { mode: "json" }).$type<string[]>().notNull(),
    /** Agents: repos it may act on; NULL = every repo its owner can access (see Principal.repoIds). */
    repoIds: text("repo_ids", { mode: "json" }).$type<string[] | null>(),
    /** Set when the owner revokes the agent's session; a disabled principal authenticates nowhere. */
    disabledAt: text("disabled_at"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("principals_user_id_uq").on(t.userId),
    index("principals_owner_id_idx").on(t.ownerId),
  ],
);

export const principalKeys = sqliteTable(
  "principal_keys",
  {
    id: text("id").primaryKey(),
    principalId: text("principal_id")
      .notNull()
      .references(() => principals.id, { onDelete: "cascade" }),
    alg: text("alg", { enum: ["Ed25519"] }).notNull(),
    publicKey: text("public_key").notNull(),
    createdAt: text("created_at").notNull(),
    revokedAt: text("revoked_at"),
  },
  (t) => [index("principal_keys_principal_id_idx").on(t.principalId)],
);

/** Platform bearer tokens for agent principals. Only the SHA-256 of the token is stored. */
export const agentTokens = sqliteTable(
  "agent_tokens",
  {
    id: text("id").primaryKey(),
    principalId: text("principal_id")
      .notNull()
      .references(() => principals.id, { onDelete: "cascade" }),
    /** hex SHA-256 of the full token string. */
    tokenHash: text("token_hash").notNull(),
    /** First characters of the token, for display ("gtf_Ab12Cd34"). */
    prefix: text("prefix").notNull(),
    scopes: text("scopes", { mode: "json" }).$type<string[]>().notNull(),
    createdBy: text("created_by").references(() => principals.id),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at"),
    lastUsedAt: text("last_used_at"),
    revokedAt: text("revoked_at"),
    /**
     * RFC 8707 audience: the resource URIs (`<origin>/mcp`, `<origin>/api`) this token is valid
     * for. NULL = any platform resource (tokens a human creates directly on the Agents screen).
     */
    audience: text("audience", { mode: "json" }).$type<string[] | null>(),
    /** OAuth / device-flow session that minted this token (agent_sessions.id), if any. */
    sessionId: text("session_id"),
  },
  (t) => [
    uniqueIndex("agent_tokens_token_hash_uq").on(t.tokenHash),
    index("agent_tokens_principal_id_idx").on(t.principalId),
    index("agent_tokens_session_id_idx").on(t.sessionId),
  ],
);

// ---------------------------------------------------------------- repos & plans

export const repos = sqliteTable(
  "repos",
  {
    id: text("id").primaryKey(),
    namespace: text("namespace").notNull(),
    artifactsName: text("artifacts_name").notNull(),
    name: text("name").notNull(),
    defaultBranch: text("default_branch").notNull().default("main"),
    jurisdiction: text("jurisdiction", { enum: ["eu", "us", "unrestricted"] }).notNull(),
    importedFrom: text("imported_from"),
    /** RepoPolicy JSON, read from the default branch at `policy_sha`. */
    policy: text("policy", { mode: "json" }).$type<unknown>().notNull(),
    policySha: text("policy_sha"),
    deployTarget: text("deploy_target"),
    /** Onboarding §4: unclaimed projects are created without an account and expire unless claimed. */
    claimStatus: text("claim_status", { enum: ["claimed", "unclaimed"] })
      .notNull()
      .default("claimed"),
    claimOwnerId: text("claim_owner_id"),
    claimExpiresAt: text("claim_expires_at"),
    template: text("template"),
    createdBy: text("created_by"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("repos_artifacts_name_uq").on(t.artifactsName),
    uniqueIndex("repos_namespace_name_uq").on(t.namespace, t.name),
    index("repos_claim_expiry_idx").on(t.claimStatus, t.claimExpiresAt),
    index("repos_claim_owner_idx").on(t.claimOwnerId),
  ],
);

export const plans = sqliteTable(
  "plans",
  {
    id: text("id").primaryKey(),
    repoId: text("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    intent: text("intent").notNull(),
    acceptanceCriteria: text("acceptance_criteria", { mode: "json" }).$type<string[]>().notNull(),
    outOfScope: text("out_of_scope", { mode: "json" }).$type<string[]>().notNull(),
    riskDeclarations: text("risk_declarations", { mode: "json" })
      .$type<{ area: string; description: string }[]>()
      .notNull(),
    scopePaths: text("scope_paths", { mode: "json" }).$type<string[]>().notNull(),
    affectedRoutes: text("affected_routes", { mode: "json" }).$type<string[]>().notNull(),
    status: text("status", { enum: ["draft", "approved", "superseded", "rejected"] }).notNull(),
    authorId: text("author_id")
      .notNull()
      .references(() => principals.id),
    approvedBy: text("approved_by").references(() => principals.id),
    approvedAt: text("approved_at"),
    approvalSignature: text("approval_signature"),
    /** Key that produced `approval_signature` (see /.well-known/gittifacts-keys.json). */
    approvalKeyId: text("approval_key_id"),
    supersedes: text("supersedes").references((): AnySQLiteColumn => plans.id),
    /** Reviewer comment on approve/reject. */
    decisionComment: text("decision_comment"),
    decidedBy: text("decided_by"),
    decidedAt: text("decided_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("plans_repo_created_idx").on(t.repoId, t.createdAt),
    index("plans_author_id_idx").on(t.authorId),
    index("plans_supersedes_idx").on(t.supersedes),
  ],
);

/**
 * Every policy the coordinator evaluated from a default-branch sha (`Store.setRepoPolicy`), so a
 * change's rollout can be explained with the policy from its BASE, not the repo's current one.
 */
export const repoPolicies = sqliteTable(
  "repo_policies",
  {
    repoId: text("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    sha: text("sha").notNull(),
    policy: text("policy", { mode: "json" }).$type<unknown>().notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.repoId, t.sha] })],
);

// ---------------------------------------------------------------- changes

export const changes = sqliteTable(
  "changes",
  {
    id: text("id").primaryKey(),
    repoId: text("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    planId: text("plan_id").references(() => plans.id),
    title: text("title").notNull(),
    claimCategory: text("claim_category").notNull(),
    claimSummary: text("claim_summary"),
    baseSha: text("base_sha").notNull(),
    headSha: text("head_sha"),
    forkName: text("fork_name").notNull(),
    authorId: text("author_id")
      .notNull()
      .references(() => principals.id),
    status: text("status").notNull(),
    computedLane: integer("computed_lane"),
    lane: integer("lane"),
    laneReasons: text("lane_reasons", { mode: "json" }).$type<unknown[]>().notNull(),
    evidenceId: text("evidence_id"),
    tourId: text("tour_id"),
    flagKey: text("flag_key"),
    mergedSha: text("merged_sha"),
    rolloutState: text("rollout_state", { mode: "json" }).$type<unknown>(),
    /** Denormalized `rollout_state.versionId`: issue webhooks are attributed through it. */
    rolloutVersionId: text("rollout_version_id"),
    revertOf: text("revert_of"),
    revertedBy: text("reverted_by"),
    agentTraceId: text("agent_trace_id"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("changes_fork_name_uq").on(t.forkName),
    index("changes_repo_status_idx").on(t.repoId, t.status),
    index("changes_repo_updated_idx").on(t.repoId, t.updatedAt),
    index("changes_plan_id_idx").on(t.planId),
    index("changes_author_id_idx").on(t.authorId),
    index("changes_rollout_version_idx").on(t.rolloutVersionId),
    index("changes_revert_of_idx").on(t.revertOf),
  ],
);

export const pipelineRuns = sqliteTable(
  "pipeline_runs",
  {
    id: text("id").primaryKey(),
    changeId: text("change_id")
      .notNull()
      .references(() => changes.id, { onDelete: "cascade" }),
    headSha: text("head_sha").notNull(),
    engine: text("engine", { enum: ["cloudflare-ci", "workflows"] }).notNull(),
    status: text("status").notNull(),
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
    steps: text("steps", { mode: "json" }).$type<unknown[]>().notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("pipeline_runs_change_head_idx").on(t.changeId, t.headSha)],
);

/** ChangeDiff per (change, head). `json` inline when small, else `r2_key` → BLOBS. */
export const diffs = sqliteTable(
  "diffs",
  {
    changeId: text("change_id")
      .notNull()
      .references(() => changes.id, { onDelete: "cascade" }),
    headSha: text("head_sha").notNull(),
    baseSha: text("base_sha").notNull(),
    json: text("json"),
    r2Key: text("r2_key"),
    sizeBytes: integer("size_bytes").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.changeId, t.headSha] })],
);

/** Signed evidence per (change, head). Same inline/R2 split as diffs. */
export const evidence = sqliteTable(
  "evidence",
  {
    id: text("id").primaryKey(),
    changeId: text("change_id")
      .notNull()
      .references(() => changes.id, { onDelete: "cascade" }),
    headSha: text("head_sha").notNull(),
    baseSha: text("base_sha").notNull(),
    keyId: text("key_id").notNull(),
    notesWritten: integer("notes_written", { mode: "boolean" }).notNull(),
    json: text("json"),
    r2Key: text("r2_key"),
    sizeBytes: integer("size_bytes").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [uniqueIndex("evidence_change_head_uq").on(t.changeId, t.headSha)],
);

export const classifications = sqliteTable(
  "classifications",
  {
    changeId: text("change_id")
      .notNull()
      .references(() => changes.id, { onDelete: "cascade" }),
    headSha: text("head_sha").notNull(),
    lane: integer("lane").notNull(),
    computedLane: integer("computed_lane").notNull(),
    shadow: integer("shadow", { mode: "boolean" }).notNull(),
    blocked: integer("blocked", { mode: "boolean" }).notNull(),
    requiresHumanApproval: integer("requires_human_approval", { mode: "boolean" }).notNull(),
    /** Full ClassifyResult (reasons + checklist). */
    json: text("json", { mode: "json" }).$type<unknown>().notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.changeId, t.headSha] })],
);

export const tours = sqliteTable(
  "tours",
  {
    id: text("id").primaryKey(),
    changeId: text("change_id")
      .notNull()
      .references(() => changes.id, { onDelete: "cascade" }),
    headSha: text("head_sha").notNull(),
    json: text("json", { mode: "json" }).$type<unknown>().notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("tours_change_head_idx").on(t.changeId, t.headSha, t.createdAt)],
);

export const reviews = sqliteTable(
  "reviews",
  {
    id: text("id").primaryKey(),
    changeId: text("change_id")
      .notNull()
      .references(() => changes.id, { onDelete: "cascade" }),
    headSha: text("head_sha").notNull(),
    reviewerId: text("reviewer_id")
      .notNull()
      .references(() => principals.id),
    decision: text("decision", { enum: ["approve", "request-changes", "reject"] }).notNull(),
    humanLane: integer("human_lane"),
    computedLane: integer("computed_lane").notNull(),
    comment: text("comment"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    index("reviews_change_id_idx").on(t.changeId, t.createdAt),
    index("reviews_computed_lane_idx").on(t.computedLane),
  ],
);

/** Workers Issues as received by the webhook (raw kept for re-parsing once the payload is known). */
export const issues = sqliteTable(
  "issues",
  {
    id: text("id").primaryKey(),
    changeId: text("change_id").references(() => changes.id, { onDelete: "set null" }),
    scriptName: text("script_name").notNull(),
    title: text("title").notNull(),
    count: integer("count").notNull(),
    firstSeen: text("first_seen").notNull(),
    lastSeen: text("last_seen").notNull(),
    versionId: text("version_id"),
    url: text("url"),
    raw: text("raw", { mode: "json" }).$type<unknown>(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("issues_version_id_idx").on(t.versionId, t.lastSeen),
    index("issues_change_id_idx").on(t.changeId, t.lastSeen),
    index("issues_last_seen_idx").on(t.lastSeen),
  ],
);

/** Query mirror of the AuditLog Durable Object (the DO is the source of truth). */
export const auditEvents = sqliteTable(
  "audit_events",
  {
    /** AuditLog instance name (one per org; "global" for now). */
    log: text("log").notNull().default("global"),
    seq: integer("seq").notNull(),
    at: text("at").notNull(),
    principalId: text("principal_id").notNull(),
    action: text("action").notNull(),
    subject: text("subject").notNull(),
    payloadHash: text("payload_hash").notNull(),
    prevHash: text("prev_hash").notNull(),
    hash: text("hash").notNull(),
    signature: text("signature").notNull(),
    keyId: text("key_id").notNull(),
    payload: text("payload", { mode: "json" }).$type<unknown>(),
  },
  (t) => [
    primaryKey({ columns: [t.log, t.seq] }),
    index("audit_events_subject_seq_idx").on(t.log, t.subject, t.seq),
    index("audit_events_principal_seq_idx").on(t.log, t.principalId, t.seq),
  ],
);

/**
 * Idempotency keys (onboarding §5): (principal, key) → fingerprint of the first request and its
 * response, kept 24 h. A replay returns the stored response; another request under the same key
 * is a 409. `status` is null while the first request is still running.
 */
export const idempotencyKeys = sqliteTable(
  "idempotency_keys",
  {
    principalId: text("principal_id").notNull(),
    key: text("key").notNull(),
    /** hex SHA-256 of "<method> <path>\n<body>". */
    requestHash: text("request_hash").notNull(),
    status: integer("status"),
    response: text("response"),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.principalId, t.key] }),
    index("idempotency_keys_expires_idx").on(t.expiresAt),
  ],
);

/** Notifier port sink: what the UI shows as "needs your attention". */
export const notifications = sqliteTable(
  "notifications",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    changeId: text("change_id"),
    repoId: text("repo_id"),
    message: text("message").notNull(),
    createdAt: text("created_at").notNull(),
    readAt: text("read_at"),
  },
  (t) => [
    index("notifications_change_id_idx").on(t.changeId, t.createdAt),
    index("notifications_created_at_idx").on(t.createdAt),
  ],
);

// ---------------------------------------------------------------- views

/**
 * Shadow-mode samples: every human review joined with its change's repo. The classifier's
 * `shadowAgreement()` only counts rows whose computed lane was 0.
 */
export const shadowSamples = sqliteView("shadow_samples").as((qb) =>
  qb
    .select({
      reviewId: sql<string>`${reviews.id}`.as("review_id"),
      repoId: sql<string>`${changes.repoId}`.as("repo_id"),
      changeId: sql<string>`${reviews.changeId}`.as("change_id"),
      headSha: sql<string>`${reviews.headSha}`.as("head_sha"),
      computedLane: sql<number>`${reviews.computedLane}`.as("computed_lane"),
      humanLane: sql<number | null>`${reviews.humanLane}`.as("human_lane"),
      decision: sql<string>`${reviews.decision}`.as("decision"),
      createdAt: sql<string>`${reviews.createdAt}`.as("created_at"),
    })
    .from(reviews)
    .innerJoin(changes, eq(changes.id, reviews.changeId)),
);
