# Release safety & observability on Cloudflare: merge → gradual rollout → watch → auto-revert (verified 2026-10-01)

Everything here was checked against primary sources on 2026-10-01. It was all read-only: nothing was created, modified or deleted. Source tags:

- **[T]** `@cloudflare/workers-types@5.20261001.1` `index.d.ts:line`
- **[W]** `wrangler@4.145.0` `config-schema.json:line` / `wrangler-dist/cli.js:line`
- **[FS]** `@cloudflare/flagship@0.5.0` `dist/<file>:line` (npm tarball, published ~Sep 2026)
- **[CF]** `cf@1.0.0-beta.10`: `cf schema <cmd>`, `<cmd> --help`, `dist/_meta/schemas.json`, `dist/sdk-*.mjs`
- **[LIVE]** read-only `cf … list/get` against the authenticated account (no IDs reproduced)
- **[D:x]** `https://developers.cloudflare.com/x/index.md`. **[API:x]** `https://developers.cloudflare.com/api/resources/x/…/index.md`. **[B:x]** `https://blog.cloudflare.com/x/`

## 0. TL;DR

1. **Flagship is real and usable.** Binding key `flagship: [{binding, app_id}]`. The binding is `Flagship` with `get*Value` / `get*Details` methods. There's no `evaluate()` method. REST lives at `/accounts/{a}/flagship/apps/{app}/flags[/{key}]`. Update is **PUT, full replacement** (no PATCH), so a kill switch is a GET → `enabled:false` → PUT. Propagation takes **up to 30 s** [D:flagship/concepts].
2. **Workers Issues** (open beta 2026-09-30) is enabled with `observability.issues.enabled: true` (wrangler ≥ 4.134.0). Webhooks go through **Notifications**: create a webhook destination, then a policy with `alert_type: workers_observability_real_time_issue` [LIVE], then an **Issues automation** that references `policyId` [CF]. The webhook uses the generic Notifications envelope. **The Issues `data` payload isn't documented.** Authentication is the shared secret echoed in `cf-webhook-auth` (no HMAC) or mTLS.
3. **Error rate by version** works today through the Workers Observability telemetry query API: group by `$workers.scriptVersion.id` × `$workers.outcome` [LIVE keys]. Tail Workers (`TraceItem.scriptVersion`) or Analytics Engine (`index1 = versionId`) are alternatives.
4. **Gradual deploy and rollback use one endpoint.** `POST /workers/scripts/{s}/deployments {strategy:"percentage", versions:[{version_id,percentage}], annotations:{"workers/message"}}` (live 2026-10-02: `workers/triggered_by` is rejected with 10210 "Invalid annotations"). Rollback is the same call with 100% on the old version. There's no rollback endpoint [W cli.js:163199, 354800]. Version annotations now include `workers/commit_sha`, `workers/pull_request_*` and `workers/repository_url` [API].
5. **There is no `CF-Version-Metadata` header.** Use the `version_metadata` binding (`{id, tag, timestamp}`) [T:17994].
6. **Browser Run** has binding `browser: {binding}`, typed `BrowserRun.quickAction("screenshot", opts) → Response` [T:13554]. You can also use `@cloudflare/puppeteer.launch(env.BROWSER)` or REST `/browser-rendering/screenshot`.
7. **AI Gateway** offers `env.AI.run(model, input, {gateway:{id, metadata}})` and REST `api.cloudflare.com/client/v4/accounts/{a}/ai/v1/chat/completions` + `cf-aig-gateway-id`. Auto Router is `model: "cloudflare/auto"`. Spend limits are **gateway rules** (≤20) partitioned by metadata keys such as `change_id`. There's no per-request $ cap.

---

## 1. Flagship (feature flags, OpenFeature)

**Wrangler** [D:flagship/configuration] [W config-schema.json:1545]:
```jsonc
{ "flagship": [ { "binding": "FLAGS", "app_id": "<APP_ID>", "remote": true /* optional, local dev */ } ] }
```
`flagship` is **not inherited** by named envs. `remote: true` = "evaluate against the remote Flagship app during local dev, instead of the local simulator" [W:1545]. The docs instead say there's no local flag store (see §8).

**Binding interface** [T:15253-15382]:
```ts
type FlagshipEvaluationContext = Record<string, string | number | boolean>;   // flat only
interface FlagshipEvaluationDetails<T> { flagKey: string; value: T; variant?: string; reason?: string; errorCode?: string; errorMessage?: string }
declare abstract class Flagship {
  get(flagKey: string, defaultValue?: unknown, context?: FlagshipEvaluationContext): Promise<unknown>;
  getBooleanValue(k: string, d: boolean, ctx?): Promise<boolean>;   getBooleanDetails(k, d: boolean, ctx?): Promise<FlagshipEvaluationDetails<boolean>>;
  getStringValue (k: string, d: string,  ctx?): Promise<string>;    getStringDetails (…)
  getNumberValue (k: string, d: number,  ctx?): Promise<number>;    getNumberDetails (…)
  getObjectValue<T extends object>(k, d: T, ctx?): Promise<T>;      getObjectDetails<T>(…)
}
// usage
const on = await env.FLAGS.getBooleanValue("merge-123-new-path", false, { targetingKey: repoId, plan: "pro" });
```
Reasons are `TARGETING_MATCH | SPLIT | DEFAULT | DISABLED`, plus SDK-side `CACHED | ERROR`. Error codes are `TYPE_MISMATCH | FLAG_NOT_FOUND | INVALID_CONTEXT | PARSE_ERROR | GENERAL`, and every error returns the default value [D:flagship/reference/evaluation-reasons].

**OpenFeature** [FS README; dist/index-DUf5c2A9.d.mts:161-250; dist/server.d.mts:47-74]:
```ts
import { OpenFeature } from "@openfeature/server-sdk";              // peer dep ^1.20.2
import { FlagshipServerProvider, type FlagshipBinding } from "@cloudflare/flagship/server";
await OpenFeature.setProviderAndWait(new FlagshipServerProvider({ binding: env.FLAGS /*, cacheTtl: 30_000 */ }));
const v = await OpenFeature.getClient().getBooleanValue("dark-mode", false, { targetingKey: "user-123" });
// HTTP mode (outside Workers): { appId, accountId, authToken, timeout=5000, retries=1, retryDelay=1000, cacheTtl?, cacheMaxSize=1000 }
// → GET https://api.cloudflare.com/client/v4/accounts/{acct}/flagship/apps/{app}/evaluate?flagKey=…&<ctx as query> [FS src-D4U5NA2u.mjs]
// response: { flagKey, value, variant, reason: 'TARGETING_MATCH'|'DEFAULT'|'DISABLED'|'SPLIT' }
```
`cacheTtl` is off by default. With it on, a flip is visible only after the TTL expires. Leave it unset for kill-switch flags. `TelemetryHook` and `LoggingHook` are exported from `/server`.

**REST** (all `/client/v4/accounts/{account_id}/flagship/…`) [CF schemas.json; API:flagship]:

| op | method/path | cf CLI |
|---|---|---|
| create app | `POST /apps {name}` (1–64 `[A-Za-z0-9_-]`) | `cf flagship apps create --name` |
| list/get/update/delete app | `GET /apps`, `GET/PUT/DELETE /apps/{app_id}` | `cf flagship apps list|get|update|delete` |
| create flag | `POST /apps/{app}/flags` (409 if key exists) | `cf flagship apps flags create <app-id> --body …` |
| get/list flag | `GET /apps/{app}/flags/{key}`, `GET /apps/{app}/flags?limit&cursor` | `… flags get|list` |
| **update flag** | `PUT /apps/{app}/flags/{key}`: **replaces entire definition**, omitted fields are dropped, appends changelog | `… flags update <flag-key> --app-id` |
| delete flag | `DELETE /apps/{app}/flags/{key}` (typed binding accessors then return default) | `… flags delete` |
| changelog | `GET /apps/{app}/flags/{key}/changelog?limit&cursor` | `… flags changelog list` |
| evaluate | `GET /apps/{app}/evaluate?flagKey&targetingKey&…`, `POST /apps/{app}/evaluate` (OFREP-shaped JSON ctx) | `… apps evaluate get`, `… flags evaluate` |
| definitions | `GET /apps/{app}/definitions` | `… apps definitions get` |

Required create/update body fields: `key, enabled, default_variation, variations, rules` [CF sdk bundle `flagship_create_flag.requiredRequestProperties`]. `cf … flags create` exposes **no `--variations` flag**, so use `--body`. Token permissions are `Flagship Read|Write|Evaluate`, or app-scoped `Flagship App Read|Write|Evaluate` [D:flagship/api-tokens].

```jsonc
// POST /apps/{app}/flags   (PUT body identical; must resend everything)
{ "key": "chg-7f3a-new-merge", "enabled": true, "description": "change 7f3a",
  "variations": { "on": true, "off": false },            // same type for all; ≤10KB each; type inferred ("type" deprecated)
  "default_variation": "off",                           // served when disabled OR no rule matches
  "rules": [                                             // ascending unique priority (≥1), first match wins
    { "priority": 1, "serve_variation": "on",
      "conditions": [ { "attribute": "plan", "operator": "equals", "value": "enterprise" } ] },
    { "priority": 2, "serve_variation": "on", "conditions": [],          // [] = match all
      "rollout": { "percentage": 10, "attribute": "repoId" } },          // 0–100, 0.01 step; default bucket attr targetingKey
    { "priority": 3, "serve_variation": "on",
      "conditions": [ { "logical_operator": "OR", "clauses": [            // nesting ≤5
        { "attribute": "beta", "operator": "equals", "value": true },
        { "attribute": "email", "operator": "ends_with", "value": "@acme.dev" } ] } ] } ] }
```
The API schema has 13 operators [API flags/methods/create]: `equals not_equals greater_than less_than greater_than_or_equals less_than_or_equals contains starts_with ends_with in not_in has not_has`. Comparisons accept numbers or ISO-8601 datetimes, and string ops are case-sensitive [D:flagship/targeting/operators]. Multi-way splits use **cumulative** thresholds (30/70/100). A context that falls outside a rule's percentage continues to the next rule. If the bucket attribute is missing, bucketing is random per request [D:flagship/targeting/percentage-rollouts].

**Kill switch**: in REST, `GET flag` → set `enabled:false` → `PUT`. A disabled flag ignores rules and serves `default_variation`. Wrangler wraps this as `wrangler flagship flags disable <APP_ID> <key…>`, plus `enable`, `rollout --to on --percentage 25 --by user_id`, and `split -w v1=80 -w v2=20`. `rollout` and `split` **replace the whole rule set** [D:flagship/reference/wrangler-commands]. The `cf` CLI has no enable/disable/rollout verbs.

**Propagation**: "up to 30 seconds … to reflect globally" [D:flagship/concepts]. Evaluation runs locally at the edge on the propagated config and keeps working if the control plane is down.

**Limits** [D:flagship/reference/limits]: 10k apps per account and 5k flags per app (both soft). Keys are ≤64 chars, condition strings ≤256, variant values ≤10 KB, config ≤25 MB per app.

## 2. Workers Issues (open beta, 2026-09-30)

**Enable** (wrangler ≥ 4.134.0) [D:workers/observability/issues] [W config-schema.json:4277]:
```jsonc
{ "observability": { "enabled": true, "issues": { "enabled": true } } }   // TOML: [observability.issues] enabled = true
// cf config: defineConfig({ worker: { observability: { issues: { enabled: true } } } })
```
Wrangler-deployed Workers must keep the key set. Otherwise the next deploy turns Issues off. Issues only processes traffic after you enable it (no backfill). It's free during the beta.

**What gets detected** [D:…/issues/investigate] [B:real-time-issue-detection]: uncaught exceptions, failed invocations, 5xx responses, error-level `console` logs and logs containing an `Error` or stack trace, runaway alarms, and log-in-loop floods. Workers Logs and tracing are **not** required. Tracing is only needed to add context through `tracing.getActiveSpan()?.setAttribute("change.id", id)` from `cloudflare:workers`.

**Data model.**
- An **issue** is a group of related **occurrences** from the same Worker. Status is `active` (default), `resolved` (a new occurrence reopens it) or `ignored`. Issues never auto-resolve. Occurrence details are kept for 7 days.
- Each occurrence carries the error, a source-mapped stack, related logs and traces, **the Worker version**, request and invocation details, and span attributes [D:…/investigate].
- An **issue group** is a manual merge of several issues under a title: `POST …/issues/groups {issueIds,title}` [CF].
- Fields inferred from `cf observability issues list --order-by` choices: `id, service, title, type, status, statusUpdated, count, firstObserved, lastObserved, created, updated` [CF --help]. Grouping and fingerprint semantics aren't documented.

**REST** (`/accounts/{a}/workers/observability/issues…`) [CF schemas.json]:

| | |
|---|---|
| `GET /issues?page&perPage&order&orderBy&search&service&type&status` | list (`cf observability issues list`) |
| `GET /issues/{id}`, `PATCH /issues/{id} {status?, title?}` | get / resolve / ignore |
| `GET /issues/{id}/occurrences?cursor&per_page` | occurrences |
| `GET /issues/summary?service` | summary |
| `POST /issues/{id}/notification-runs {policyId?}` | **manual send** to a destination |
| `POST /issues/groups {issueIds,title}`, `DELETE /issues/groups/{g}`, `POST/DELETE /issues/groups/{g}/members[/{issueId}]` | issue groups |
| `POST|GET|PUT|DELETE /issues/automations[/{id}]` body `{policyId (req), name?, enabled?, service?, afterOccurrences?, afterInactivitySeconds?}` | automations (omit `service` for account-wide) |

Triggers [D:…/issues/automations]:
- **occurrence threshold** fires once, when the count crosses N (minimum 1).
- **recurrence after inactivity** waits 1 h to 365 d.

Limits: 50 automations per account. Each run is handed off up to 3 times. "Succeeded" means Notifications accepted the event.

**Webhook wiring**. Issues automations point at a **Notifications policy**:
```bash
# 1) destination (secret echoed back verbatim in cf-webhook-auth; never returned by API)
POST /accounts/{a}/alerting/v3/destinations/webhooks      {"name":"gittifacts-issues","url":"https://hooks.example/cf-issues","secret":"<random>"}
# 2) policy  (alert_type from GET /alerting/v3/available_alerts → "workers_observability_real_time_issue", no filters [LIVE])
POST /accounts/{a}/alerting/v3/policies {"name":"issues→gittifacts","alert_type":"workers_observability_real_time_issue","enabled":true,"mechanisms":{"webhooks":[{"id":"<webhook_id>"}]}}
# 3) automation
POST /accounts/{a}/workers/observability/issues/automations {"policyId":"<policy_id>","service":"<script>","afterOccurrences":5,"enabled":true,"name":"canary"}
# cf: cf alerting destinations webhooks create | cf alerting policies create | cf observability issues automations create
```
**Payload, captured live 2026-10-02** (account-wide automation, a throwaway `gf-` Worker that throws):
```json
{ "name":"gittifacts-workers-issues", "text":"Real-Time Issue '<title>' detected in <script>. …",
  "data":{ "issue":{ "id":"<uuid>", "title":"probe boom 3 · at Object.fetch (index.js)", "fingerprint":"<hex>",
      "count":"1", "first_observed":"2026-10-02T15:47:09.217Z", "last_observed":"…", "status":"ISSUE_STATUS_ACTIVE",
      "type":"ISSUE_TYPE_EXCEPTION", "services":[{ "name":"<script>", "type":"SERVICE_TYPE_WORKER", "first_observed":"…", "last_observed":"…" }] },
    "state_correlation_id":"<uuid>", "state_event":"ALERT_STATE_EVENT_START" },
  "ts":1790956056, "policy_id":"…", "policy_name":"…", "alert_type":"workers_observability_real_time_issue",
  "alert_event":"ALERT_STATE_EVENT_START", "alert_correlation_id":"<uuid>" }
```
**No version id**: read it from the newest occurrence, `GET …/issues/{id}/occurrences` → `[{ timestamp, error:{message,stack,…},
worker:{ scriptName, scriptVersion:{id} }, invocation, request }]`. Each distinct error message is its own issue. Latency
measured: occurrence → issue created ≈ 21 s → webhook delivered ≈ 31 s. Creating a destination sends a `{"text":"Hello World! …"}`
test message (no `alert_type`, no `data`). An account-wide automation (`service` omitted) reports `"scope":"account"`.

Before the capture, the envelope was documented [D:notifications/reference/webhook-payload-schema] but `data` was not:
```json
{ "name":"<policy name>", "text":"<human summary>", "data":{ /* alert-specific, undocumented for Issues */ },
  "ts":1790870150, "account_id":"…", "policy_id":"…", "policy_name":"…",
  "alert_type":"workers_observability_real_time_issue", "alert_correlation_id":"<uuid>", "alert_event":"ALERT_STATE_EVENT_START" }
```
**Authenticity**: the request carries `cf-webhook-auth: <your secret>`. Reject it when the header is missing or doesn't match, using a constant-time compare. There is **no HMAC or timestamp signature**. mTLS is the alternative [D:…/issues/automations; D:notifications/get-started/configure-webhooks]. Webhooks come from Cloudflare IP ranges and are delivered only to public IPs on ports 80/443. Don't trust `data`: re-fetch the issue through `GET /issues/{id}` before acting. Note that the docs say generic webhooks need ≥1 Pro zone, yet this account reports `webhooks.eligible: true` [LIVE `cf alerting destinations eligible get`].

## 3. Querying error rate per version

### 3a. Workers Observability telemetry query (Workers Logs dataset)
Enable logs with `observability.logs` (`enabled`, `head_sampling_rate` 0..1 default 1, `invocation_logs`, `persist`, `destinations[]`) [W:4258]. Retention is 7 days, and accounts over 5B logs/day are sampled at 1% [D:workers/observability/logs/workers-logs]. Confirmed keys [LIVE `cf observability telemetry keys`]: `$workers.scriptVersion.id`, `$workers.scriptName`, `$workers.eventType`, `$workers.outcome`, `$workers.event.response.status` (number), `$workers.cpuTimeMs`, `$workers.wallTimeMs`, `$metadata.service`, `$metadata.error`, `$metadata.level`. The response schema also lists `$workers.scriptVersion.{message,tag}` [API:workers/…/telemetry/methods/query], but only `.id` appeared in this account's keys.
```jsonc
// POST /accounts/{a}/workers/observability/telemetry/query     (cf observability telemetry query)
{ "queryId": "adhoc-canary-chg-7f3a", "dry": true,               // dry = don't persist the run
  "timeframe": { "from": 1790869000000, "to": 1790869900000 },  // unix ms
  "view": "calculations", "chartType": "aggregate",
  "parameters": {
    "filters": [ { "key": "$workers.scriptName", "operation": "eq", "type": "string", "value": "git-api" },
                 { "key": "$workers.eventType", "operation": "eq", "type": "string", "value": "fetch" } ],
    "calculations": [ { "operator": "count", "alias": "n" } ],
    "groupBys": [ { "type": "string", "value": "$workers.scriptVersion.id" },
                  { "type": "string", "value": "$workers.outcome" } ],
    "limit": 100 } }
// → result.calculations[0].aggregates[] = { count, value, interval, sampleInterval, groups:[{key,value}] }
```
- **Filter ops**: `includes not_includes starts_with ends_with regex exists is_null in not_in eq neq gt gte lt lte`, with uppercase aliases.
- **Calc ops**: `count uniq min max sum avg median p001…p999 stddev variance`.
- **Other parameters**: `havings`, `orderBy`, `needle`, `filterCombination`, and nested `kind:"group"` filters (depth ≤4).
- **`$workers.outcome` values**: `ok canceled exception unknown killSwitch daemonDown exceededCpu exceededMemory loadShed responseStreamDisconnected scriptNotFound internalError exceededWallTime` [T:17522].
- **Error rate per version** = Σ(non-`ok` + 5xx) / Σ. A second calc filtered on `$workers.event.response.status gte 500` covers the 5xx part.
- **Sampling**: honor `head_sampling_rate`. The response carries `sampleInterval`.

### 3b. Analytics Engine (exact, cheap, 3-month retention)
```jsonc
{ "analytics_engine_datasets": [ { "binding": "REL", "dataset": "release_events" } ],
  "version_metadata": { "binding": "CF_VERSION_METADATA" } }        // [W:1026, 1174]
```
```ts
// [T:836-843] writeDataPoint(event?: { indexes?: (ArrayBuffer|string|null)[]; doubles?: number[]; blobs?: (ArrayBuffer|string|null)[] }): void
const { id: versionId, tag } = env.CF_VERSION_METADATA;                // [T:17994] { id, tag, timestamp }
env.REL.writeDataPoint({ indexes: [versionId],                         // 1 index ≤96B, sampling key
  blobs: [scriptName, tag, changeId, String(status)], doubles: [isError ? 1 : 0, latencyMs] });
// limits: ≤20 blobs (≤16KB total), ≤20 doubles, ≤250 points/invocation [D:analytics/analytics-engine/limits]
```
```sql
-- POST https://api.cloudflare.com/client/v4/accounts/{a}/analytics_engine/sql   (Bearer token: Account Analytics Read; body = raw SQL)
SELECT index1 AS version_id, blob3 AS change_id,
       SUM(_sample_interval) AS requests,
       SUM(_sample_interval * double1) AS errors,
       SUM(_sample_interval * double1) / SUM(_sample_interval) AS error_rate
FROM release_events
WHERE timestamp > NOW() - INTERVAL '10' MINUTE AND blob1 = 'git-api'
GROUP BY version_id, change_id FORMAT JSON
```
Sampling is keyed on `index1`, so per-version counts stay exact-ish only when weighted by `_sample_interval` [D:analytics/analytics-engine/sql-api]. `INTERVAL` supports `SECOND…YEAR`.

### 3c. Other paths
- **Tail Worker**: `tail_consumers`. `TraceItem.scriptVersion?: {id, tag, message}` and `outcome` [T:3242-3280] give a push-based, real-time counter.
- **GraphQL** `workersInvocationsAdaptive` (`sum{requests errors}`, `status`) [D:analytics/graphql-api/tutorials/querying-workers-metrics]. Its tutorial doesn't show a version dimension.
- **Analytics SQL binding** (`analytics: {binding}` [W:1071], `AnalyticsSQLBinding.query({query, params})` → `{data, rows, statistics}` [T:12426]). It is undocumented (§9).

## 4. Versions, gradual deployments, rollback

**Upload a version** (not deployed): `wrangler versions upload --tag <t> --message <m>` [D:workers/wrangler/commands/workers]. REST: `POST /accounts/{a}/workers/scripts/{s}/versions` (multipart `metadata` + modules). Annotations in `metadata.annotations` [API:workers/scripts/versions/methods/create]:
```jsonc
{ "workers/message": "≤1000B", "workers/tag": "≤100B (user id, e.g. change id)", "workers/alias": "≤63",
  "workers/commit_sha": "≤64", "workers/pull_request_number": "≤20", "workers/pull_request_title": "≤512",
  "workers/pull_request_url": "≤512", "workers/repository_url": "≤512" }
```
`wrangler versions upload` and `wrangler deploy` only send `workers/message` and `workers/tag` (plus `workers/alias` with `--preview-alias`) [W cli.js:175811, 176359]. The commit and PR annotations are filled by wrangler only for Previews (from `GITHUB_SHA|CI_COMMIT_SHA|CIRCLE_SHA1|COMMIT_SHA`) [W:176928, 177745]. **To tie a version to a change id, set `workers/tag` = change id and `workers/commit_sha` yourself via REST.** Version-response metadata has `{author_email, created_on, source ('wrangler'|'api'|'cf_cli'|'workersci'…), number, hasPreview}`.

**Deploy / gradual split** [API:workers/scripts/deployments/methods/create] [W cli.js:163199]:
```jsonc
// POST /accounts/{a}/workers/scripts/{script}/deployments[?force=true]
{ "strategy": "percentage",
  "versions": [ { "version_id": "<new>", "percentage": 10 }, { "version_id": "<old>", "percentage": 90 } ],  // sum = 100, min 0.01
  "annotations": { "workers/message": "chg-7f3a canary 10%" } }   // "workers/triggered_by" → 10210 (live 2026-10-02)
// response: { id, created_on, source, strategy, versions[], annotations, author_email }
```
- **CLI**: `wrangler versions deploy <new>@10% <old>@90% --message "…" -y` (also `--version-tag t@10`), or `cf workers deployments create --worker <s> --strategy percentage --versions '[…]'`.
- **Limits**: at most **2 versions per deployment** [D:…/version-overrides]. Only the last 100 uploaded versions are deployable.
- **Read current state**: `GET /workers/scripts/{s}/deployments` → `{deployments:[…]}`. Wrangler treats the newest `created_on` as active [W:163158, 354701]. Deployable versions: `GET /workers/scripts/{s}/versions?deployable=true` → `{items}` [W:163192]. Also `wrangler deployments status --json` and `cf workers deployments list|get`.

**Rollback** = a new deployment with 100% on the target [D:…/rollbacks] [W cli.js:354694-354850]:
- `wrangler rollback [VERSION_ID] --message "…"`. With no ID it picks the newest older deployment that had a 100% version.
- REST: `POST …/deployments {strategy:"percentage", versions:[{version_id:<stable>, percentage:100}], annotations:{"workers/message":"auto-revert chg-7f3a"}}`.
- **API error `10220`**: secrets changed since that version. Retry with `?force=true` (`--bypass-deployment-checks` in cf).
- **Blocked** when a DO class lifecycle change happened in between, or a bound R2/KV/Queue was deleted.
- **Bindings and data aren't rolled back.** Only the last 100 versions are eligible.

**Version inside the Worker** [D:workers/runtime-apis/bindings/version-metadata] [W:1174] [T:17994]:
```ts
// wrangler: "version_metadata": { "binding": "CF_VERSION_METADATA" }
const { id, tag, timestamp } = env.CF_VERSION_METADATA as WorkerVersionMetadata;
resp.headers.set("x-version-id", id);   // no platform CF-Version-Metadata header exists; echo it yourself
```
Request headers that do exist:
- `Cloudflare-Workers-Version-Overrides: <worker>="<version-id>"`: RFC 8941 dict that forces a version in the current deployment (works at 0%). It is forwarded through service bindings.
- `Cloudflare-Workers-Version-Key: <key>`: sticky version affinity across gradual steps [D:…/version-overrides; D:…/gradual-deployments/version-affinity].

Logpush `ScriptVersion {id,message,tag}` field is API-only [D:…/gradual-deployments].

## 5. Browser Run (formerly Browser Rendering)

**Wrangler**: `"browser": { "binding": "BROWSER", "remote"?: boolean }`. Not inherited by envs [W:1051] [D:browser-run/reference/wrangler].
```ts
// [T:13079-13086, 13554-13580]
declare abstract class BrowserRun {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;          // used by @cloudflare/puppeteer
  quickAction(action: "screenshot", options: BrowserRunScreenshotOptions): Promise<Response>; // + "pdf"|"content"|"scrape"|"links"|"snapshot"|"json"|…
}
type BrowserRunScreenshotOptions = ({ url: string } | { html: string }) & BrowserRunBaseOptions & {
  selector?: string; scrollPage?: boolean; browser?: "kitesurf";
  screenshotOptions?: { type?: "png"|"jpeg"|"webp"; encoding?: "binary"|"base64"; quality?: number; fullPage?: boolean;
    clip?: { x; y; width; height; scale? }; omitBackground?: boolean; optimizeForSpeed?: boolean; captureBeyondViewport?: boolean; fromSurface?: boolean } };
// 200 → image bytes (or text/plain data URI if base64); errors → JSON 400/422/429/500/503; header X-Browser-Ms-Used
const shot = await env.BROWSER.quickAction("screenshot", { url: previewUrl, screenshotOptions: { fullPage: true, type: "webp" } });
await env.BUCKET.put(`shots/${changeId}.webp`, shot.body);
```
- **Puppeteer**: `import puppeteer from "@cloudflare/puppeteer"` (npm 1.4.0; the docs still say v1.1.0). `const b = await puppeteer.launch(env.BROWSER, { keep_alive: 600000 }); const p = await b.newPage(); await p.goto(url); await p.screenshot(); await b.close();` [D:browser-run/puppeteer]. Idle sessions close after 60 s by default (10 min max via `keep_alive`).
- **REST**: `POST https://api.cloudflare.com/client/v4/accounts/{a}/browser-rendering/screenshot?cacheTTL=` with body `{url|html, screenshotOptions, viewport, gotoOptions, waitForSelector, cookies, authenticate, …}`. Needs a token with *Browser Rendering – Edit*. The docs also show `/browser-run/screenshot`, while cf uses `/browser-rendering/…` [CF `cf browser-run quick-action screenshot`; D:browser-run/quick-actions/screenshot-endpoint]. The default viewport is 1920×1080, and `quality` requires `type: jpeg`.
- **Limits, Free**: 10 browser-min/day; quick actions 1 per 10 s; 3 concurrent sessions.
- **Limits, Paid**: quick actions 30/s; 200 concurrent browsers; 3 new browsers/s [D:browser-run/limits].

## 6. AI Gateway + Auto Router

**From a Worker** (`"ai": {"binding":"AI"}` [W config-schema]):
```ts
// [T:12200-12210, 12286-12296, 12389-12400]
const out = await env.AI.run("anthropic/claude-sonnet-5" /* or "@cf/…" */, { messages, response_format },
  { gateway: { id: "gittifacts", metadata: { change_id: "chg-7f3a", repo: "r1" },   // ≤5 entries, string|number|boolean
               cacheTtl, skipCache, collectLog, eventId, requestTimeoutMs, retries } });
const logId = env.AI.aiGatewayLogId;
const gw = env.AI.gateway("gittifacts");   // AiGateway: patchLog(id,{score,feedback,metadata}), getLog(id), run(universalReq), getUrl(provider?)
const anthropicBase = await gw.getUrl("anthropic"); // https://gateway.ai.cloudflare.com/v1/{acct}/{gw}/anthropic
```
`env.AI.gateway()` does **not** call models. Third-party models on the binding use Unified Billing (credits). Only a BYOK key under alias `default` is consulted [D:ai-gateway/usage/worker-binding-methods].

**HTTP** [D:ai-gateway/usage/rest-api]:
- `POST https://api.cloudflare.com/client/v4/accounts/{a}/ai/v1/chat/completions` (OpenAI). Siblings: `/ai/v1/responses`, `/ai/v1/messages` (Anthropic schema, no `@cf/`), and `/ai/run` (envelope `{model,input,options:{background,webhookUrl}}`).
- Auth: `Authorization: Bearer <token with Workers AI Read>`. Select the gateway with `cf-aig-gateway-id: <gw>`. The `default` gateway is used if omitted, and the header is required for `@cf/`.
- `…/v1/{a}/{gw}/compat/chat/completions` is **deprecated for single-model** use but still needed for dynamic routes [D:…/usage/chat-completion].
- Provider-native: `https://gateway.ai.cloudflare.com/v1/{a}/{gw}/anthropic/v1/messages` with `cf-aig-authorization: Bearer <CF token>` (+ `x-api-key` or stored BYOK / Unified Billing).

**Headers** [D:ai-gateway/glossary]:
- `cf-aig-metadata: {"change_id":"chg-7f3a"}` (JSON, ≤5 keys, `cf.*` reserved). It appears in logs and **keys spend limits**.
- Caching: `cf-aig-cache-ttl|skip-cache|cache-key`. Retries: `cf-aig-max-attempts|retry-delay|backoff`. Timeout: `cf-aig-request-timeout`.
- Also `cf-aig-collect-log`, `cf-aig-custom-cost`, `cf-aig-event-id`, and `cf-aig-no-wholesale` (forbid Unified Billing fallback).
- Response headers: `cf-aig-log-id`, `cf-aig-cache-status`, `cf-aig-step`.

**Auto Router** (public beta 2026-09-30, free during beta) [D:ai-gateway/features/auto-router] [B:auto-router]:
- Set `"model": "cloudflare/auto"`. It supports Chat Completions and Responses formats (no WebSockets; the blog lists full Responses support as roadmap).
- Request headers: `cf-aig-session-id` (turn-level model pinning for prompt cache), `cf-aig-turn-id`, `cf-aig-no-session-affinity: true`, `cf-aig-allowed-models: anthropic/*,openai/gpt-5.6-sol`, `cf-aig-allowed-providers: anthropic,workers-ai`. Both allow-lists must match, and a non-matching entry → 400.
- Response headers: `cf-aig-routed-model`, `cf-aig-routing-reason` (`cost_optimal_within_pool|forced_by_candidate_pool|pinned_by_turn|fallback_*`), `cf-aig-routing-decision-id`, `cf-aig-request-id`.
- Default pool: `anthropic/claude-{fable-5,opus-5,sonnet-5}`, `openai/gpt-5.6-{luna,sol,terra}`, `xai/grok-4.5`.
- Opt-in pool:
  - `anthropic/claude-{fable-5.1,opus-4.8,opus-5.5,sonnet-4.6}`, `openai/gpt-5.5`, `openai/gpt-6-{astra,luna,sol}`, `xai/grok-4.6`
  - `alibaba/qwen3.8-max`, `fireworks/glm-5.3[-flash]`, `minimax/m3`
  - Workers AI `@cf/deepseek-ai/deepseek-v4-{flash-0731,pro-0813}`, `@cf/google/gemma-4-26b-a4b-it`, `@cf/moonshotai/kimi-k2.7-code`, `@cf/openai/gpt-oss-20b`, `@cf/qwen/qwen3.8-27b`, `@cf/zai-org/glm-5.2`
- The pool is pre-filtered by request format and inputs, credentials, billing, and spend limits.

**Spend limits** [D:ai-gateway/features/spend-limits] [API:ai_gateway/methods/update]:
- Rules are per gateway (≤20) and set via `PUT /accounts/{a}/ai-gateway/gateways/{id}` (cf: `cf ai-gateway gateways update --spend-limits-enabled`, rules via `--body`).
- Over budget → **429** before the provider call. Enforcement is eventually consistent: concurrent bursts can overshoot. It covers Unified Billing and BYOK for models with known pricing.
- To fall back instead of blocking, use a Dynamic Route whose primary model carries the limit.
- There is no per-request $ cap: use `max_tokens`, plus a per-`change_id` partition rule.
```jsonc
"spend_limits": { "enabled": true, "rules": [ {
  "id": "per-change", "enabled": true, "limit": 5, "limitType": "cost", "window": 86400, "technique": "fixed",  // or "sliding"
  "metadata": { "change_id": { "mode": "partition" } },                   // split: one budget per change id
  "model": { "mode": "filter", "values": ["anthropic/claude-opus-5"] } } ] }   // provider: same shape
```
**Structured JSON**: OpenAI-style `response_format: {type:"json_schema", json_schema:{…}}` works on Workers AI ("JSON Mode") [D:workers-ai/features/json-mode]. Through `/ai/v1/chat/completions` it passes to OpenAI-compatible providers. Native Anthropic structured output works on `/ai/v1/messages` or the `anthropic/` path. With `cloudflare/auto` it is unverified (§9).

## 7. Notifications (generic webhooks) quick reference

[CF schemas.json] [API:alerting/policies/methods/create]
```
POST   /accounts/{a}/alerting/v3/destinations/webhooks          {name, url, secret?}   → {id}   (PUT/{id} to update, GET, DELETE)
GET    /accounts/{a}/alerting/v3/destinations/eligible           (webhooks.eligible)
GET    /accounts/{a}/alerting/v3/available_alerts                (find alert_type + filter keys)
POST   /accounts/{a}/alerting/v3/policies                        {name, alert_type, enabled, mechanisms:{webhooks:[{id}],email:[{id:addr}],pagerduty:[{id}]}, filters?, alert_interval?, description?}
POST   /accounts/{a}/alerting/v3/policies/{id}/test              (sends a test)
GET    /accounts/{a}/alerting/v3/history                         (sent notifications)
POST   /accounts/{a}/alerting/v3/silences                         (mute)
```
- Relevant alert types [LIVE available_alerts]:
  - `workers_observability_real_time_issue`: Issues, no filters.
  - `workers_observability_alert`: Observability alert policies, filter `status`. Payload `data:{account,config,episode:{first_failed,first_fired,last_failed,resolved_at,summary},status}` [D:…/webhook-payload-schema].
- `alert_event` is `ALERT_STATE_EVENT_START|END`. Use `alert_correlation_id` to dedupe.

## 8. Discrepancies vs prompt

1. **Flagship binding has no `evaluate(...)`.** Use `getBooleanValue/getStringValue/getNumberValue/getObjectValue/get` plus `get*Details` [T:15282]. Context is a **flat** `Record<string, string|number|boolean>`. Nested values throw `INVALID_CONTEXT` in the HTTP SDK.
2. **`cf flagship apps flags create|update` take no `--variations` flag.** Pass a full JSON body with `--body`. `update` is a full-replace PUT, and the cf CLI has no enable/disable verbs. Kill switch = read-modify-write PUT. `wrangler flagship flags disable` does the same.
3. **Flagship operators**: the docs say "11 operators". The API schema adds `has` and `not_has` (13). The docs also say "no local flag store", while wrangler's schema has `flagship[].remote` "instead of the local simulator".
4. **Issues webhook data**:
   - The generic webhook is the standard Notifications envelope.
   - There's no documented Issues-specific schema (script name, version id, first seen, count and fingerprint are all unconfirmed).
   - Authentication is a plain shared secret in `cf-webhook-auth`, not a signature.
5. **Issues config**: webhooks aren't configured in wrangler. They need Notifications destination + policy (`workers_observability_real_time_issue`) + an Issues automation referencing `policyId`. "Issue group" in the API means a **manual grouping of issues**, not the automatic occurrence grouping.
6. **No `CF-Version-Metadata` header exists.** Use the `version_metadata` binding (`id, tag, timestamp`). The related platform headers are `Cloudflare-Workers-Version-Overrides` and `Cloudflare-Workers-Version-Key`.
7. **Annotations**: `workers/tag` is version-only. Deployments accept `workers/message`; `workers/triggered_by` is rejected live (10210 "Invalid annotations", 2026-10-02). Versions also accept `workers/commit_sha`, `workers/pull_request_{number,title,url}`, `workers/repository_url` and `workers/alias`.
8. **No rollback REST endpoint.** Rollback = `POST …/deployments` at 100%, with `?force=true` on error 10220.
9. **Browser Run REST path**: the docs mix `/browser-run/screenshot` and `/browser-rendering/screenshot`; cf uses the latter. The binding type is `BrowserRun` with `quickAction()`, while docs examples still type it `Fetcher` for Puppeteer.
10. **AI Gateway**:
    - `env.AI.gateway()` is for logs and URLs, not inference.
    - The `gateway.ai.cloudflare.com/…/compat` universal endpoint is deprecated for single-model use in favor of `api.cloudflare.com/…/ai/v1/*`.
    - There is no per-request or per-key budget, only gateway spend-limit rules keyed by model, provider or metadata.
    - The public API reference shows `model`/`provider` dimensions with `mode:"filter"` only, while the dashboard docs say both can "split by value".
11. **The Notifications API reference `alert_type` enum is stale.** It omits `workers_observability_real_time_issue` and `workers_*`. Use `GET available_alerts`.

## 9. Open questions

1. ~~**Issues webhook `data` shape.**~~ Answered 2026-10-02 (§2): `data.issue` has the id, title, fingerprint, count, timestamps and `services[].name`; no version id (it is on each occurrence).
2. **Issues API response shapes.** `ListIssuesResponse` and `OccurrencesIssuesResponse` are typed but not documented. Does an occurrence expose `scriptVersion.id` as a field (the docs say version is shown in the UI)? Are issues deduped across versions?
3. **Flagship PUT concurrency.** No ETag or `If-Match` is documented, so concurrent agent writes can clobber each other. We need serialization on our side, for example a DO per app. The changelog GET can audit after the fact.
4. **Flagship propagation SLO.** "Up to 30 s" vs "within seconds". Is there an API signal that a flag change has propagated?
5. **AI Gateway spend-limit `window` units** (seconds assumed in the example above). Does a fixed window align to the calendar? Can `model`/`provider` use `partition` via the API?
6. **Auto Router edge cases.**
   - Does `cloudflare/auto` work on `/ai/v1/chat/completions` and `env.AI.run`? The docs only show `/compat`.
   - Does the router respect `response_format`/`tools` by filtering the pool?
   - Is session affinity honored with the binding?
7. **Analytics SQL binding.** `analytics: {binding}` → `AnalyticsSQLBinding.query()` exists in types and schema [T:12426, W:1071] but has no docs page. Can it query `events.analyticsEngine.<dataset>` from a Worker? It would remove the API-token hop for the watcher. `GET /analytics/sql/introspection` returned 403 with the current token [LIVE].
8. **Telemetry query cost and limits.** Rate limits and maximum timeframe for `/telemetry/query` are undocumented. Does `dry:true` avoid billing or persistence?
9. **The Pro-plan requirement for generic webhooks** is stated in the Notifications docs. Is it enforced for Issues automations on Workers-only accounts? This account shows eligible.
10. **Gradual deploys with Durable Objects** use per-DO version assignment (see compute.md). A canary's error rate in DO-heavy Workers may not track its traffic percentage.
