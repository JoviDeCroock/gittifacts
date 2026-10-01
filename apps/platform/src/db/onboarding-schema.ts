/**
 * Onboarding tables (docs/prompts/02-onboarding.md §1, §3): change previews served by the preview
 * gateway, and per-project time-to-first-green timestamps (the dashboard's source when the
 * Analytics Engine SQL API is not reachable).
 */
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * One row per (change, head) preview: `id` is the pinned preview id `p-<changeId>-<sha8>`. The
 * latest alias `p-<changeId>` resolves to the newest row of the change.
 */
export const previews = sqliteTable(
  "previews",
  {
    id: text("id").primaryKey(),
    changeId: text("change_id").notNull(),
    repoId: text("repo_id").notNull(),
    projectName: text("project_name").notNull(),
    headSha: text("head_sha").notNull(),
    /** Artifacts repo the CI checked out (a fork, or the main repo for a bootstrap). */
    artifactsRepo: text("artifacts_repo").notNull(),
    /** Container snapshot the preview starts from, and the CI step that made it. */
    snapshotId: text("snapshot_id").notNull(),
    snapshotStep: text("snapshot_step", { enum: ["build", "install"] }).notNull(),
    template: text("template"),
    claimed: integer("claimed", { mode: "boolean" }).notNull(),
    status: text("status", { enum: ["starting", "ready", "failed"] }).notNull(),
    detail: text("detail"),
    createdAt: text("created_at").notNull(),
    readyAt: text("ready_at"),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("previews_change_created_idx").on(t.changeId, t.createdAt)],
);

/** Time-to-first-green per project: request start → CI green + preview serving. */
export const projectOnboarding = sqliteTable(
  "project_onboarding",
  {
    projectId: text("project_id").primaryKey(),
    template: text("template"),
    source: text("source", { enum: ["template", "import", "empty"] }).notNull(),
    principalId: text("principal_id").notNull(),
    bootstrapChangeId: text("bootstrap_change_id"),
    /** create_project request received. */
    createdAt: text("created_at").notNull(),
    /** create_project responded. */
    respondedAt: text("responded_at"),
    /** The bootstrap Change sealed its evidence (first CI finished). */
    evidenceAt: text("evidence_at"),
    /** The first preview answered (null: none, or it failed). */
    previewReadyAt: text("preview_ready_at"),
    ciStatus: text("ci_status"),
    previewStatus: text("preview_status"),
    /** green | ci-failed | preview-failed | no-preview; null while pending. */
    outcome: text("outcome"),
    msToRespond: integer("ms_to_respond"),
    msToGreen: integer("ms_to_green"),
    msToPreview: integer("ms_to_preview"),
  },
  (t) => [index("project_onboarding_created_idx").on(t.createdAt)],
);
