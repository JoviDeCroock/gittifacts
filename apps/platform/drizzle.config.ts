import { defineConfig } from "drizzle-kit";

// Generate only: `pnpm db:generate --name <slug>` writes migrations/NNNN_<slug>.sql.
// Apply only with wrangler (`pnpm db:migrate:local|remote`), which tracks d1_migrations.
// D1 always enforces foreign keys: hand-edit any generated `PRAGMA foreign_keys=OFF` into
// `PRAGMA defer_foreign_keys = on` (docs/research/stack.md §1).
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./migrations",
});
