/**
 * CLI-only shim for `auth generate` (better-auth schema generation). Never imported by the Worker.
 *
 *   pnpm exec auth generate --config src/auth.cli.ts --adapter drizzle --dialect sqlite \
 *     --output src/db/auth-schema.ts -y
 */
import { createAuth } from "./auth/better-auth.js";

export const auth = createAuth(
  {
    DB: {} as D1Database,
    BETTER_AUTH_SECRET: "x".repeat(32),
    BETTER_AUTH_URL: "http://localhost:5173",
    GITHUB_CLIENT_ID: "x",
    GITHUB_CLIENT_SECRET: "x",
  },
  { origin: "http://localhost:5173" },
);
