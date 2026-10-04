/**
 * On-request QA runs (docs/research/agentic-qa.md): one row per run, at most one per (change,
 * head) unless re-run on purpose. The signed `qa-run` evidence item is the record of truth; this
 * row is the request, its progress and a copy of the item for listing.
 */
import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const QA_STATUSES = ["queued", "running", "done", "failed"] as const;
export const QA_TRIGGERS = ["platform", "mcp", "cli", "github-check", "github-comment"] as const;

export const qaRuns = sqliteTable(
  "qa_runs",
  {
    id: text("id").primaryKey(),
    changeId: text("change_id").notNull(),
    repoId: text("repo_id").notNull(),
    headSha: text("head_sha").notNull(),
    status: text("status", { enum: QA_STATUSES }).notNull(),
    trigger: text("trigger", { enum: QA_TRIGGERS }).notNull(),
    requestedBy: text("requested_by").notNull(),
    /** GitHub login that asked (github-check / github-comment). */
    requestedLogin: text("requested_login"),
    /** Short progress line while running ("booting the app", "criterion 2 of 4"). */
    progress: text("progress"),
    /** The signed item (a copy), once done. */
    item: text("item", { mode: "json" }).$type<unknown>(),
    passed: integer("passed"),
    failed: integer("failed"),
    couldntTest: integer("couldnt_test"),
    /** The lane before and after the run (after ≥ before: QA only raises). */
    laneBefore: integer("lane_before"),
    laneAfter: integer("lane_after"),
    costUsd: real("cost_usd"),
    wallMs: integer("wall_ms"),
    error: text("error"),
    createdAt: text("created_at").notNull(),
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
  },
  (t) => [
    index("qa_runs_change_idx").on(t.changeId, t.createdAt),
    index("qa_runs_repo_idx").on(t.repoId, t.createdAt),
  ],
);
export type QaRunRow = typeof qaRuns.$inferSelect;
