// Setup files run outside per-file storage isolation and may run repeatedly; already-applied
// migrations are skipped.
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
