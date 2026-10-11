/**
 * Overlapping work (services/overlaps.ts): the paths or globs an agent said it would touch when it
 * started a Change (`start_change` `paths`). Until the Change has a pushed head these are what
 * other agents are compared against, so two agents starting at once see each other by path.
 * Never an input to the lane. Bounded: at most 50 paths of at most 300 characters (the zod input).
 */
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { changes } from "./app-schema.js";

export const changeIntents = sqliteTable("change_intents", {
  changeId: text("change_id")
    .primaryKey()
    .references(() => changes.id, { onDelete: "cascade" }),
  /** JSON array of normalized paths/globs (≤ 50). */
  paths: text("paths", { mode: "json" }).$type<string[]>().notNull(),
  createdAt: text("created_at").notNull(),
});
