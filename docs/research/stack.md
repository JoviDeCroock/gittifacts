# Application stack: versions, recipes, gotchas

Researched 2026-10-01 with `npm view`, `npm pack` (reading the `.d.ts` files) and the current docs. Recipes 1–6 were
**run end to end** in a scratch Worker: `tsc` (TS 6.0.3 and 7.0.2) passed with no errors, the `@cloudflare/vitest-plugin`
suite passed (D1 migrations, email sign-up, cookie and bearer sessions on an OpenAPI route, an API key used to call an MCP
tool, the OpenAPI doc), and `vite build` plus `wrangler deploy --dry-run` succeeded (776 KiB gzip).

## 0. Pinned versions

| Package | Pin | Notes |
|---|---|---|
| wrangler | 4.145.0 | `compatibility_flags: ["nodejs_compat"]` is required (better-auth) |
| hono | 4.13.12 | |
| @hono/zod-openapi | 1.6.3 | peers: `zod ^4`, `hono >=4.10`; uses `@asteasolutions/zod-to-openapi` 9.1.0 |
| @scalar/hono-api-reference | 0.12.8 | `Scalar({ url })` docs UI |
| zod | 4.6.5 | v4 everywhere; nothing in this stack needs v3 |
| drizzle-orm / drizzle-kit | 0.45.3 / 0.31.11 | `latest` tags. The docs site now defaults to `@rc` (1.0.0-rc.5); avoid it (§1) |
| better-auth (+ `@better-auth/api-key`, `@better-auth/passkey`) | 1.7.7 | CLI is the **`auth`** package, also 1.7.7 |
| @modelcontextprotocol/server | 2.2.0 | SDK v2, MCP spec 2026-07-28. `@modelcontextprotocol/sdk` 1.31.0 is the legacy v1 line |
| agents | 0.24.0 | optional; see §4 for its pinned peer versions |
| preact / @preact/signals / preact-iso | 11.0.0 / 2.11.3 / 2.12.2 | peers accept 11 (`>=11.0.0-0`) |
| @preact/preset-vite / vite | 2.10.6 / 8.3.2 | preset peer `vite 2.x–8.x`; `@prefresh/vite@2.4.12` peer accepts preact 11 |
| @cloudflare/vite-plugin | 1.62.3 | only needed for option B in §5 |
| vitest | **4.1.11** | **not 5.0.3**: the Workers plugin peers `vitest ^4.1.0` |
| @cloudflare/vitest-plugin | 1.3.4 | **replaces `@cloudflare/vitest-pool-workers`** (0.22.0 was its last release, 2026-08-18) |
| typescript | 6.0.3 | per DECISIONS.md; the recipes also typecheck on 7.0.2 |

**Incompatibilities and traps found**
1. **vitest 5.x** (latest is 5.0.3) is outside `@cloudflare/vitest-plugin`'s peer range `^4.1.0`. Stay on 4.1.11 (dist-tag `V4`).
2. **`@cloudflare/vitest-pool-workers` was renamed `@cloudflare/vitest-plugin`** (same API; codemod
   `pnpm dlx @cloudflare/codemods vitest:pool-workers-to-vitest-plugin`). package.json already uses the new name; DECISIONS.md doesn't.
3. **`@better-auth/cli` is stale.** Its `latest` is 1.4.21, which bundles better-auth 1.4 and drizzle 0.41. Use `pnpm dlx auth@1.7.7 …`.
4. **`agents@0.24.0` hard-pins its MCP peers** (`@modelcontextprotocol/sdk` 1.30.0, `server` 2.0.0, `client` 2.0.0; none optional).
   Its `McpAgent` is deprecated and feature-frozen. Use `@modelcontextprotocol/server` directly (§4).
5. **Drizzle 1.0 RC** changes the migration layout to nested `<name>/migration.sql`. Wrangler then needs `migrations_pattern`,
   and `readD1Migrations` needs `{ migrationsDir, migrationsPattern }`. Stay on 0.45 for now.
6. **chanfana 3.4.0** lists `zod ^4.4.3` and `zod-to-openapi ^8.5` as regular dependencies, not peers. Mixing it with
   `@hono/zod-openapi` (which uses zod-to-openapi ^9.1) installs two converters.
7. **pnpm 11** already has `minimumReleaseAgeExclude` entries for day-old releases and `allowBuilds` for `esbuild` and `workerd`.
   Keep both; `workerd`'s postinstall is required.

## 1. Drizzle + D1

```ts
// apps/platform/drizzle.config.ts
import { defineConfig } from "drizzle-kit";
export default defineConfig({
  dialect: "sqlite",               // no driver needed to *generate*
  schema: "./src/db/schema.ts",
  out: "./migrations",             // flat 0000_<name>.sql + meta/ (wrangler ignores meta/)
  // To use studio/push against remote D1 (optional):
  // driver: "d1-http", dbCredentials: { accountId, databaseId, token },
});
```

```ts
// apps/platform/src/db/app-schema.ts  (sqlite-core syntax, verified)
import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { user } from "./auth-schema";

export const artifact = sqliteTable("artifact", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  ownerId: text("owner_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  slug: text("slug").notNull(),
  kind: text("kind", { enum: ["doc", "image", "code"] }).notNull(),          // TS union, no CHECK
  meta: text("meta", { mode: "json" }).$type<{ tags: string[] }>().notNull().default(sql`'{"tags":[]}'`),
  isPublic: integer("is_public", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (t) => [                                   // array form; the object form is deprecated
  uniqueIndex("artifact_owner_slug_uq").on(t.ownerId, t.slug),
  index("artifact_public_created_idx").on(t.createdAt).where(sql`${t.isPublic} = 1`), // partial index
]);
// src/db/schema.ts: export * from "./auth-schema"; export * from "./app-schema";
```

Other column modes: `integer({ mode: "timestamp" })` (seconds), `blob({ mode: "buffer" | "bigint" | "json" })`. The source
recommends `text({ mode: "json" })` over blob-json because SQLite's JSON functions work on it. Composite and named
foreign keys use `foreignKey({ columns, foreignColumns }).onDelete("cascade")` inside the extra-config array.
FK actions: `cascade | restrict | no action | set null | set default`.

```ts
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./db/schema";
const db = drizzle(env.DB, { schema });     // cheap; build it per request
await db.batch([db.insert(artifact).values(a), db.update(user).set(u).where(eq(user.id, id))]); // atomic
```

Workflow: `pnpm drizzle-kit generate --name <slug>` writes `migrations/NNNN_<slug>.sql`; `wrangler d1 migrations apply <db> --local|--remote`
applies it, with `"d1_databases": [{ "binding": "DB", "database_name": "…", "database_id": "…", "migrations_dir": "migrations" }]`.

Gotchas:
- Apply migrations **only** with wrangler, which tracks them in `d1_migrations`. `drizzle-kit migrate` tracks them in
  `__drizzle_migrations` and `push` tracks nothing, so mixing tools double-applies or drifts.
- D1 has no interactive transactions. Use `db.batch()`, which is atomic.
- D1 always enforces foreign keys, and SQL cannot turn that off. drizzle-kit's SQLite "recreate table" migrations emit
  `PRAGMA foreign_keys=OFF`, which D1 can't honor. Hand-edit those files to use `PRAGMA defer_foreign_keys = on` (D1 docs).
  With `ON DELETE CASCADE`, review any rebuild of a parent table.
- The `--> statement-breakpoint` markers drizzle-kit writes are SQL comments. Both wrangler and `readD1Migrations` handle them (verified).

## 2. better-auth 1.7.7 on Workers + D1

```ts
// apps/platform/src/auth.ts
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle"; // = @better-auth/drizzle-adapter
import { bearer, organization } from "better-auth/plugins";
import { apiKey } from "@better-auth/api-key";                  // moved out of core in 1.7
import { passkey } from "@better-auth/passkey";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./db/schema";

export type AuthEnv = { DB: D1Database; BETTER_AUTH_URL: string; BETTER_AUTH_SECRET: string;
  GITHUB_CLIENT_ID: string; GITHUB_CLIENT_SECRET: string };

export function createAuth(env: AuthEnv, ctx?: { waitUntil(p: Promise<unknown>): void }) {
  const url = new URL(env.BETTER_AUTH_URL);
  return betterAuth({
    baseURL: env.BETTER_AUTH_URL,                 // origin the browser sees, e.g. https://app.example
    secret: env.BETTER_AUTH_SECRET,               // >= 32 chars (`pnpm dlx auth@1.7.7 secret`)
    database: drizzleAdapter(drizzle(env.DB, { schema }), { provider: "sqlite", schema }), // transaction:false (default) — keep for D1
    emailAndPassword: { enabled: true },
    socialProviders: { github: { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET } },
    session: { cookieCache: { enabled: true, maxAge: 300 } },        // fewer D1 reads per request
    advanced: ctx ? { backgroundTasks: { handler: (p) => ctx.waitUntil(p) } } : undefined,
    plugins: [
      bearer(),
      organization(),
      apiKey({ defaultPrefix: "gtf_", rateLimit: { enabled: false } }), // see gotchas
      passkey({ rpID: url.hostname, rpName: "gittifacts", origin: url.origin }),
    ],
  });
}
export type Auth = ReturnType<typeof createAuth>;
```

For `ctx` you can also use `import { waitUntil } from "cloudflare:workers"`, which is typed in workers-types 5.x.

**Schema generation.** The CLI loads a module that exports `auth`, so keep a CLI-only shim. The CLI stubs `cloudflare:workers`.
```ts
// src/auth.cli.ts — never imported by the Worker
import { createAuth } from "./auth";
export const auth = createAuth({ DB: {} as D1Database, BETTER_AUTH_URL: "http://localhost:5173",
  BETTER_AUTH_SECRET: "x".repeat(32), GITHUB_CLIENT_ID: "x", GITHUB_CLIENT_SECRET: "x" });
```
`pnpm dlx auth@1.7.7 generate --config src/auth.cli.ts --adapter drizzle --dialect sqlite --output src/db/auth-schema.ts -y`
writes snake_case columns, `timestamp_ms` dates, indexes and `relations()`. Then run `drizzle-kit generate`.
Tables it generated with the plugins above (bearer and GitHub add none):

| Table | Columns (FK → user.id cascade unless noted) |
|---|---|
| user | id, name, email (unique), email_verified, image, created_at, updated_at |
| session | id, expires_at, token (unique), created_at, updated_at, ip_address, user_agent, user_id, active_organization_id |
| account | id, account_id, provider_id, user_id, access/refresh/id_token, access/refresh_token_expires_at, scope, password (scrypt hash), created_at, updated_at |
| verification | id, identifier (idx), value, expires_at, created_at, updated_at |
| organization | id, name, slug (unique), logo, created_at, metadata |
| member | id, organization_id (→org), user_id, role (default `member`), created_at |
| invitation | id, organization_id (→org), email, role, status (default `pending`), expires_at, created_at, inviter_id |
| apikey | id, config_id (default `default`), name, start, **reference_id** (user or org id, no FK), prefix, key (sha256 hash; idx), refill_interval, refill_amount, last_refill_at, enabled, rate_limit_enabled, rate_limit_time_window, rate_limit_max, request_count, remaining, last_request, expires_at, created_at, updated_at, permissions, metadata |
| passkey | id, name, public_key, user_id, credential_id (idx), counter, device_type, backed_up, transports, created_at, aaguid |

**Hono mount and session middleware.** This is the verified pattern. The current docs use `app.all`; `app.on(["GET","POST"], …)` also works.
```ts
type Session = NonNullable<Awaited<ReturnType<Auth["api"]["getSession"]>>>;
type AppEnv = { Bindings: Env; Variables: { auth: Auth; session: Session | null } };
app.use("*", async (c, next) => { c.set("auth", createAuth(c.env, c.executionCtx)); await next(); });
app.all("/api/auth/*", (c) => c.get("auth").handler(c.req.raw));
app.use("/api/v1/*", async (c, next) => {
  const s = await c.get("auth").api.getSession({ headers: c.req.raw.headers }); // cookie OR Authorization: Bearer (bearer plugin)
  if (!s) return c.json({ error: "unauthorized" }, 401);
  c.set("session", s); await next();
});
```
Agent and machine principals: an admin or the user creates a key with `auth.api.createApiKey({ body: { userId, name, permissions: { artifacts: ["read"] }, expiresIn } })`.
The plaintext `key` is returned once. Verify it with `auth.api.verifyApiKey({ body: { key, permissions? } })`, which returns
`{ valid, error, key: { referenceId, permissions, expiresAt, … } }`. To make keys owned by an org, use `references: "organization"`.
`enableSessionForAPIKeys: true` mocks a user session from an `x-api-key` header; the docs mark it "not recommended".

**Client (Preact).** `better-auth/client` is the vanilla client. `authClient.useSession` is a nanostores `Atom`
(`.get()` and `.subscribe()`); there is no Preact adapter, so bridge it to a signal:
```ts
import { createAuthClient } from "better-auth/client";
import { organizationClient } from "better-auth/client/plugins";
import { passkeyClient } from "@better-auth/passkey/client";
import { apiKeyClient } from "@better-auth/api-key/client";
import { signal } from "@preact/signals";
export const authClient = createAuthClient({ plugins: [organizationClient(), passkeyClient(), apiKeyClient()] }); // same-origin: no baseURL
export const session = signal(authClient.useSession.get());
authClient.useSession.subscribe((v) => { session.value = v; });   // v: { data, error, isPending, isRefetching, refetch }
// authClient.signIn.social({ provider: "github", callbackURL: "/" }); authClient.passkey.addPasskey(); authClient.apiKey.create({ name })
```

Gotchas:
- **`nodejs_compat` is required, not just `nodejs_als`.** Under the `workerd` export condition, `@better-auth/utils/password`
  imports `node:crypto` `scrypt` (N=16384, r=16, p=1, 64-byte key, about 32 MiB). The built bundle contains `from "node:crypto"`.
- **Password hashing CPU cost:** sign-up took about 107 ms wall time in local workerd (not profiled, but scrypt is the likely bulk). The Free plan's 10 ms CPU
  limit will fail sign-in and sign-up, so use the Paid plan (default 30 s CPU). Passkeys and GitHub skip hashing.
  To swap the hash, set `emailAndPassword.password: { hash, verify }`.
- **The API key plugin rate-limits each key to 10 requests per day by default** (`rateLimit.maxRequests: 10`,
  `timeWindow: 86_400_000`). Every verify also writes `request_count` and `last_request` to D1. For machine tokens, set
  `rateLimit: { enabled: false }` (or raise it), or set `deferUpdates: true`, which needs `advanced.backgroundTasks`.
- Default rate limiting (`rateLimit.storage`) is `"memory"`, which is per isolate and therefore meaningless on Workers.
  Use `"database"` (adds a `rateLimit` table, so regenerate the schema), `"secondary-storage"` (KV), or Cloudflare rate-limiting rules.
- Browser POSTs need an `Origin` that matches `baseURL` or `trustedOrigins`. Behind the Vite dev proxy, set
  `BETTER_AUTH_URL=http://localhost:5173` so cookies and the GitHub callback (`/api/auth/callback/github`) use the proxy origin.
- Bearer plugin: the token is returned in the `set-auth-token` response header. Read it with `fetchOptions.onSuccess`, send it with
  `fetchOptions.auth: { type: "Bearer", token }`. `getSession` accepts `Authorization: Bearer` (verified).
- This recipe runs `createAuth` per request (bindings come from `c.env`); I didn't measure its cost. If profiling shows it matters,
  memoize one instance per isolate using `import { env } from "cloudflare:workers"`.

## 3. Hono + OpenAPI. Recommendation: `@hono/zod-openapi`

| | @hono/zod-openapi 1.6.3 | hono-openapi 1.3.3 | chanfana 3.4.0 |
|---|---|---|---|
| zod v4 | peer `zod ^4.0.0` (v3 dropped) | any Standard Schema; zod v4 converted natively | zod ^4.4.3 as a **dependency** |
| Style | `createRoute()` + `app.openapi()`, typed `c.req.valid()` and **typed responses per status** | `describeRoute()`, `validator()` and `resolver()` middleware on plain Hono | class-based `OpenAPIRoute` via `fromHono(app)` |
| Spec | `app.doc`/`doc31`, `getOpenAPI31Document()` | `openAPIRouteHandler(app)` at runtime | `/openapi.json`; CLI runs `wrangler dev` to extract |
| RPC (`hc`) types | yes | yes | no |
| Maintainer | honojs/middleware | rhinobase (README: "still in development") | Cloudflare (Radar API) |

Choose @hono/zod-openapi. It is first-party Hono, checks response bodies against the declared statuses at compile time,
keeps Hono RPC types, and generates OpenAPI 3.1 synchronously. A plain-zod schema with `.meta({ id: "X" })` becomes
`#/components/schemas/X` (verified), so shared `packages/domain` schemas can import from `zod` and don't need the `.openapi()` extension.

```ts
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi"; // this z = zod v4 + .openapi(); plain `zod` works too
import { Scalar } from "@scalar/hono-api-reference";

const Err = z.object({ error: z.string() }).openapi("Error");
const Artifact = z.object({ id: z.string(), slug: z.string() }).meta({ id: "Artifact" });

const app = new OpenAPIHono<AppEnv>({
  defaultHook: (r, c) => { if (!r.success) return c.json({ error: r.error.message }, 422); },
});
app.openAPIRegistry.registerComponent("securitySchemes", "Bearer", { type: "http", scheme: "bearer" });

const getArtifact = createRoute({
  method: "get", path: "/api/v1/artifacts/{slug}",          // OpenAPI {param} syntax
  security: [{ Bearer: [] }],
  request: { params: z.object({ slug: z.string().min(1).openapi({ param: { name: "slug", in: "path" } }) }) },
  responses: {
    200: { content: { "application/json": { schema: Artifact } }, description: "ok" },
    401: { content: { "application/json": { schema: Err } }, description: "unauthorized" },
  },
});
app.openapi(getArtifact, (c) => c.json({ id: c.get("session")!.user.id, slug: c.req.valid("param").slug }, 200));

app.doc31("/api/openapi.json", { openapi: "3.1.0", info: { title: "gittifacts", version: "0.1.0" } });
app.get("/api/docs", Scalar({ url: "/api/openapi.json" }));
export default app;
```
Gotchas:
- Always pass the status code to `c.json(…, 200)`, or response typing breaks.
- Header schema keys must be lowercase.
- A JSON body route returns **415** when `Content-Type` is missing. Set `body.required: true` to reject an empty body.
- When mounting sub-apps, use Hono `:param` syntax (`app.route("/books/:id", sub)`).
- Plain `Hono` children are invisible to the spec, so make the whole tree `OpenAPIHono`.
- For a static `openapi.json` in CI, keep route definitions in modules that don't import `cloudflare:*` and call
  `app.getOpenAPI31Document(...)` from a `tsx` script, or `curl` it from `vite preview` or `wrangler dev`.

## 4. Remote MCP server. Recommendation: `@modelcontextprotocol/server` 2.2.0, stateless, behind our bearer check

The landscape on 2026-10-01:
- **MCP TS SDK v2** splits the old SDK into `@modelcontextprotocol/server` and `client`, and implements spec 2026-07-28, where
  per-request envelopes replace sessions. `createMcpHandler(factory)` returns a web-standard `handler.fetch(req, { authInfo })`
  and builds a fresh `McpServer` **per request**. By default (`legacy: "stateless"`) it also serves 2025-era clients statelessly;
  GET and DELETE return 405. Its `workerd` export condition auto-selects the `@cfworker/json-schema` validator (no `eval`).
- **agents 0.24.0:** `createMcpHandler` from `agents/mcp/server` wraps the same SDK v2 handler. It adds a route match, CORS,
  Host and Origin allowlists, and `getMcpAuthContext()`. `McpAgent` and `createLegacyMcpHandler` (SDK v1, sessions in a
  Durable Object) are deprecated or legacy. The catch is the exact peer pins listed in §0.
- The raw-shape `inputSchema: { a: z.string() }` form is **deprecated** in v2. Pass `z.object({...})` (any Standard Schema with JSON Schema).

Neither package issues tokens. The SDK's `requireBearerAuth` turns our verifier into a 401 or 403 response with a
`WWW-Authenticate` header. Verified recipe:
```ts
// src/mcp.ts
import { McpServer, createMcpHandler, requireBearerAuth, originValidationResponse,
  OAuthError, OAuthErrorCode, type AuthInfo } from "@modelcontextprotocol/server";
import { z } from "zod";

export const mcpHandler = createMcpHandler(({ authInfo }) => {   // per request; also gets era, requestInfo
  const server = new McpServer({ name: "gittifacts", version: "0.1.0" });
  server.registerTool("whoami", {
    description: "Return the authenticated principal",
    inputSchema: z.object({ verbose: z.boolean().optional() }),
    outputSchema: z.object({ principal: z.string(), scopes: z.array(z.string()) }),
    annotations: { readOnlyHint: true },
  }, async ({ verbose }, ctx) => {
    const who = ctx.http?.authInfo ?? authInfo;               // the exact AuthInfo our verifier returned
    const out = { principal: who?.clientId ?? "anon", scopes: who?.scopes ?? [] };
    return { content: [{ type: "text", text: verbose ? JSON.stringify(out) : out.principal }], structuredContent: out };
  });
  return server;
});

export const mcpGate = (auth: Auth) => requireBearerAuth({ verifier: { async verifyAccessToken(token): Promise<AuthInfo> {
  const r = await auth.api.verifyApiKey({ body: { key: token } });   // or our own principal-token table
  if (!r.valid || !r.key) throw new OAuthError(OAuthErrorCode.InvalidToken, "invalid token");
  const exp = r.key.expiresAt ? Math.floor(new Date(r.key.expiresAt).getTime() / 1000) : Math.floor(Date.now() / 1000) + 3600;
  return { token, clientId: r.key.referenceId, scopes: Object.keys(r.key.permissions ?? {}), expiresAt: exp };
} } });

// in the Hono app
app.all("/mcp", async (c) => {
  const bad = originValidationResponse(c.req.raw, [new URL(c.env.BETTER_AUTH_URL).hostname]); // 403 on a foreign Origin; no Origin = OK
  if (bad) return bad;
  const who = await mcpGate(c.get("auth"))(c.req.raw);
  if (who instanceof Response) return who;                       // 401 with `Bearer error="invalid_token"`
  return mcpHandler.fetch(c.req.raw, { authInfo: who });
});
```
Gotchas:
- **`requireBearerAuth` rejects an `AuthInfo` without `expiresAt`**, even for non-expiring keys. Always set it.
- The SDK handler checks neither Host nor Origin. The `originValidationResponse` and `hostHeaderValidationResponse` helpers do
  (the agents wrapper does this for you).
- `scopeChallenge: requireScopes("artifacts:write")` on a tool returns a per-tool 403 `insufficient_scope`.
- `responseMode: "json"` logs a warning that it drops mid-call notifications. Keep the default `"auto"`.
- Clients that only do MCP OAuth discovery (401 → `resource_metadata` → authorization server) need RFC 9728 metadata
  (`oauthMetadataResponse`) and an authorization server. Static principal tokens work only with clients that let you set a
  custom `Authorization` header.
- Each tool call that verifies an API key is a D1 read plus a write (see the §2 rate-limit gotcha).

## 5. Preact + signals + Vite on Workers Static Assets (same Worker)

```jsonc
// apps/platform/wrangler.jsonc (relevant parts)
{
  "main": "./src/index.ts",
  "compatibility_date": "2026-09-30",            // latest supported by workerd 1.20260930.x
  "compatibility_flags": ["nodejs_compat"],
  "assets": {
    "directory": "../../packages/web/dist",      // option A only; option B omits it
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/api/*", "/mcp", "/.well-known/*"]
  },
  "secrets": { "required": ["BETTER_AUTH_SECRET", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"] } // `wrangler types` reads this
}
```
`run_worker_first` is **mandatory** here. Since compat date 2025-04-01, navigation requests (`Sec-Fetch-Mode: navigate`) are
served from assets and **skip the Worker**. Without it, the GitHub OAuth redirect to `/api/auth/callback/github` would get
`index.html`. The array form needs wrangler ≥ 4.20 and vite-plugin ≥ 1.7.

**Router:** preact-iso. Exclude server paths so the router doesn't intercept those links:
```tsx
<LocationProvider scope={/^\/(?!api\/|mcp)/}><ErrorBoundary><Router>
  <Route path="/" component={Home} /><Route path="/settings" component={lazy(() => import("./settings"))} />
  <Route default component={NotFound} />
</Router></ErrorBoundary></LocationProvider>
```

**Build setup. Recommendation: A (separate builds) for this repo; B is verified too.**
- **A: `packages/web` builds with plain Vite, and `apps/platform` with wrangler** (this matches the existing `packages/web/vite.config.ts`
  proxy to :8787). The Worker stays on wrangler/esbuild, which is the reference path for DOs, Workflows, containers and the
  extra wrangler env DECISIONS.md plans for `CloudflareCiEngine`.
  - Order: `pnpm --filter @app/web build`, then `wrangler deploy`. Wrangler **errors if `assets.directory` doesn't exist**
    (verified), so build the web app first or `mkdir -p` it in dev. `@cloudflare/vitest-plugin` doesn't care.
  - Cost: in dev the SPA-fallback and `run_worker_first` rules are emulated by the Vite proxy, not the real asset router.
- **B: `@cloudflare/vite-plugin`** (`plugins: [preact(), cloudflare({ configPath })]`, omit `assets.directory`): one `vite dev`
  runs the Worker in workerd with real asset routing; `vite build` emits `dist/client`, `dist/<worker>/wrangler.json` and a
  `.wrangler/deploy/config.json` redirect for plain `wrangler deploy` (verified, 776 KiB gzip). Switch to B if dev/prod routing
  drift hurts; it needs the Worker entry reachable from the web package's Vite config, and `CLOUDFLARE_ENV` for wrangler envs.

## 6. Tests: `@cloudflare/vitest-plugin` 1.3.4 + vitest 4.1.11

The API is now a **Vite plugin, `cloudflareTest()`**. `defineWorkersConfig` and `poolOptions.workers` are gone, and so are
the `isolatedStorage` and `singleWorker` options. Storage is isolated **per test file**; to share it, run with
`--max-workers=1 --no-isolate`. The plugin injects `nodejs_compat` when the config doesn't set it. The `cloudflare:test`
exports `env` and `SELF` are deprecated: use `import { env, exports } from "cloudflare:workers"` and `exports.default.fetch()`.

```ts
// apps/platform/vitest.config.ts (verified)
import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
export default defineConfig(async () => ({
  plugins: [cloudflareTest({
    wrangler: { configPath: "./wrangler.jsonc" },             // main, bindings, DO/Workflow classes come from here
    miniflare: { bindings: {
      TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, "migrations")),
      BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-0123456789", GITHUB_CLIENT_ID: "x", GITHUB_CLIENT_SECRET: "x",
    } },
  })],
  test: { include: ["test/**/*.test.ts"], setupFiles: ["./test/apply-migrations.ts"] },
}));
```
```ts
// test/apply-migrations.ts — setup files run outside per-file isolation and may run repeatedly; already-applied migrations are skipped
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
// test/env.d.ts: declare namespace Cloudflare { interface Env { TEST_MIGRATIONS: import("cloudflare:test").D1Migration[] } }
// test tsconfig "types": ["@cloudflare/vitest-plugin/types", "./worker-configuration.d.ts"]  (from `wrangler types`)
```
- **Durable Objects** (class exported from `main`): `runInDurableObject(stub, async (instance, state) => …)`, `runDurableObjectAlarm(stub)`,
  `listDurableObjectIds(ns)`, `evictDurableObject(stub)`, `abortAllDurableObjects()`. WebSocket DOs need `--no-isolate`.
- **Workflows:**
  ```ts
  await using wf = await introspectWorkflow(env.INGEST);
  await wf.modifyAll(async (m) => { await m.disableSleeps(); await m.mockStepResult({ name: "fetch" }, data); });
  /* trigger */; const [i] = await wf.get(); await i.waitForStatus("complete"); expect(await i.getOutput()).toEqual(…)
  ```
  Known id: `introspectWorkflowInstance(env.INGEST, id)`. Also `mockStepError`, `forceStepTimeout`, `mockEvent`, `forceEventTimeout`, `disableRetryDelays`.
- **Queues:**
  ```ts
  const batch = createMessageBatch<Job>("jobs", [{ id, timestamp: new Date(), attempts: 1, body }]); const ctx = createExecutionContext();
  await worker.queue(batch, env, ctx); const r = await getQueueResult(batch, ctx); // r.outcome, r.explicitAcks, r.retryMessages
  ```
  Producers: call `exports.default.fetch` and assert on the effects.
- Also: `reset()` (wipes all binding storage), `createScheduledController()`, `adminSecretsStore()`; mock fetch with `@msw/cloudflare`.
- Known issues: no V8 coverage (use `@vitest/coverage-istanbul`); fake timers don't affect KV, R2 or cache; consume every
  response body; use `using` for RPC results.

**Workspace (Vitest 4 `projects`).** The root config only contributes global options (reporters, coverage, globalSetup);
each project owns its test options.
```ts
// vitest.config.ts (repo root)
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { projects: ["apps/*", "packages/*"] } });   // each dir's vitest.config.ts
// packages/domain/vitest.config.ts
import { defineProject } from "vitest/config";
export default defineProject({ test: { name: "domain", environment: "node", include: ["test/**/*.test.ts"] } });
```
Verified: a node project and a workerd project ran side by side in one `vitest run`. A Workers project without `include`
also ran the node package's tests, because its default glob reached them; always set `include`.

## 7. zod v4 compatibility matrix (4.6.5)

| Consumer | zod relationship | v4 OK? |
|---|---|---|
| @hono/zod-openapi 1.6.3 | peer `^4.0.0` | yes (v3 not supported) |
| @hono/zod-validator 0.9.1 | peer `^3.25 \|\| ^4` | yes |
| hono-openapi 1.3.3 | Standard Schema; v4 → native JSON Schema | yes |
| chanfana 3.4.0 | dependency `^4.4.3` | yes (dedupes to 4.6.5) |
| better-auth / api-key / passkey 1.7.7 | dependency `^4.5.4` | yes (dedupes) |
| @modelcontextprotocol/server 2.2.0 | dependency `^4.2.0`; schemas must be Standard Schema + JSON | yes |
| agents 0.24.0 | peer `^4.0.0` | yes |
| drizzle-zod 0.8.3 | peer `^3.25 \|\| ^4` | yes |
| @cloudflare/vitest-plugin 1.3.4 | pins `4.4.3` internally (Node side only) | harmless duplicate |

Use one `import { z } from "zod"` everywhere. The MCP docs use `import * as z from "zod/v4"`, which is the same API in zod 4.
For OpenAPI names, prefer `.meta({ id, description, example })` over `.openapi()` in shared packages.

## Sources
- `npm view` / `npm pack` (2026-10-01) for every package above. `.d.ts` read: `@cloudflare/vitest-plugin` (`dist/pool/index.d.mts`,
  `types/cloudflare-test.d.ts`), `drizzle-orm` (`d1/driver.d.ts`, `sqlite-core/*`), `drizzle-kit/index.d.ts`, `@better-auth/api-key`
  types, `better-auth/dist/client/vanilla.d.mts`, `@better-auth/core` `init-options.d.mts`, `@better-auth/utils` `password.node.mjs`,
  `@modelcontextprotocol/server` (`index.d.mts`, `createMcpHandler-*.d.mts`), `agents/dist/mcp/*.d.ts`.
- Cloudflare: developers.cloudflare.com/workers/testing/vitest-integration/{configuration, isolation-and-concurrency, known-issues,
  migration-guides/migrate-to-vitest-plugin}; workers-sdk `fixtures/vitest-plugin-examples/{d1,workflows,queues,durable-objects}`;
  /d1/reference/migrations; /d1/sql-api/foreign-keys; /workers/static-assets/routing/single-page-application;
  /workers/vite-plugin/{tutorial, reference/static-assets}; /agents/model-context-protocol/apis/handler-api.
- better-auth.com/docs (v1.7): integrations/hono, adapters/drizzle, concepts/{cli,client}, plugins/{api-key (+advanced, reference),
  bearer, passkey}, authentication/{github, email-password}.
- ts.sdk.modelcontextprotocol.io/v2/{servers/tools, serving/http, serving/authorization}.
- READMEs: @hono/zod-openapi, @asteasolutions/zod-to-openapi (`.meta()` since v8), hono-openapi, chanfana, preact-iso;
  Preact 11.0.0 release notes (2026-09-30).
