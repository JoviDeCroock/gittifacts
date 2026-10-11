/**
 * Attempts at one Plan (services/attempts.ts): several agents may attempt the same approved Plan,
 * each its own Change, and a person picks one. The pick is recorded once per Plan: the picked
 * Change was approved, the other open attempts were closed as superseded. `wait_for_change` reads
 * it to tell a closed attempt's agent `superseded` (and by which Change).
 */
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { changes, plans } from "./app-schema.js";

export const planPicks = sqliteTable("plan_picks", {
  planId: text("plan_id")
    .primaryKey()
    .references(() => plans.id, { onDelete: "cascade" }),
  changeId: text("change_id")
    .notNull()
    .references(() => changes.id, { onDelete: "cascade" }),
  /** The human who picked it (and approved it). */
  pickedBy: text("picked_by").notNull(),
  /** The head the person picked (the approval binds to it). */
  headSha: text("head_sha"),
  pickedAt: text("picked_at").notNull(),
});
