# HTTP API contract (v1)

JSON over HTTPS. All bodies validated with zod. Errors always tell the caller what to do next (onboarding §5):
`{ "error": { "code": string, "message": string, "fix": { "explanation": string, "call"?: string, "command"?: string, "docsUrl"?: string }, "details"?: unknown } }`
with a matching HTTP status (`ApiError` in `@app/domain`).

Every create/mutate call accepts an `Idempotency-Key` header. A retry with the same key and the same body returns the
stored response; the same key with a different body returns `409 idempotency-key-reuse`. Types refer to `@app/domain` / `@app/evidence`. The OpenAPI document is generated from the
route definitions and served at `GET /api/v1/openapi.json`.

## Auth
- Humans: better-auth session cookie (`/api/auth/*`, GitHub OAuth + email/password, passkeys optional).
- Agents: `Authorization: Bearer <agent token>`; a token belongs to an agent `Principal` (kind `agent`) owned by a human.
  MCP also takes OAuth access tokens, unclaimed repo tokens and anonymous calls (see `POST /mcp` below).
- Git: Artifacts repo-scoped tokens minted per Change fork (push to that fork only, short TTL).
- `GET /.well-known/gittifacts-keys.json` → `{ keys: [{ keyId, alg: "Ed25519", publicKey, notAfter? }] }` (platform signing keys).

## Identity
| Method | Path | Body | Response |
|---|---|---|---|
| GET | /api/v1/me | – | `{ principal: Principal, user: { id, email, name, image } \| null }` |
| GET | /api/v1/principals | – | `{ principals: Principal[] }` (agents the caller owns + self) |
| POST | /api/v1/principals/agents | `{ name, scopes: Scope[] }` | `{ principal: Principal, token: string }` (token shown once) |
| DELETE | /api/v1/principals/:id/tokens | – | `{ revoked: number }` |

## Repos
| Method | Path | Body | Response |
|---|---|---|---|
| GET | /api/v1/repos | – | `{ repos: RepoSummary[] }` |
| POST | /api/v1/repos | `{ name, importFrom?: githubUrl, defaultBranch? }` | `{ repo: Repo }` |
| GET | /api/v1/repos/:repoId | – | `{ repo: Repo, shadow: ShadowStats, counts: LaneCounts }` |
| PATCH | /api/v1/repos/:repoId/lane0 | `{ enabled: boolean }` | `{ repo: Repo }` (409 unless shadow threshold met; `repo:admin`) |

`RepoSummary = Repo & { counts: LaneCounts, shadow: ShadowStats }`
`LaneCounts = { lane0: number, lane1: number, lane2: number, awaitingReview: number, rollingOut: number, failing: number }`
`ShadowStats = { samples: number, agreed: number, ratio: number | null, needed: number, threshold: number, eligibleToEnableLane0: boolean }`

## Plans
| Method | Path | Body | Response |
|---|---|---|---|
| GET | /api/v1/repos/:repoId/plans | – | `{ plans: Plan[] }` |
| POST | /api/v1/plans | `PlanDraftInput` | `{ plan: Plan }` |
| GET | /api/v1/plans/:planId | – | `{ plan: Plan, changes: Change[] }` |
| POST | /api/v1/plans/:planId/approve | `{ comment? }` | `{ plan: Plan }` (human, `plan:approve`, not the author) |
| POST | /api/v1/plans/:planId/reject | `{ comment }` | `{ plan: Plan }` |

## Changes
| Method | Path | Body | Response |
|---|---|---|---|
| GET | /api/v1/repos/:repoId/changes | `?status=&lane=` | `{ changes: ChangeSummary[] }` |
| POST | /api/v1/changes | `StartChangeInput` | `{ change: Change, remote: GitRemote }` |
| GET | /api/v1/changes/:changeId | – | `{ change: Change, plan: Plan \| null, runs: PipelineRun[], classification: ClassifyResult \| null }` |
| POST | /api/v1/changes/:changeId/token | – | `{ remote: GitRemote }` (fresh short-lived push token, author only) |
| GET | /api/v1/changes/:changeId/diff | – | `{ diff: ChangeDiff }` |
| GET | /api/v1/changes/:changeId/evidence | – | `{ evidence: Evidence, verification: { ok: boolean, keyId?: string, reason?: string } }` |
| GET | /api/v1/changes/:changeId/tour | – | `{ tour: Tour }` |
| POST | /api/v1/changes/:changeId/review | `{ decision: "approve"\|"request-changes"\|"reject", humanLane?: 0\|1\|2, comment? }` | `{ change: Change }` (not the author; `change:review`) |
| GET | /api/v1/changes/:changeId/rollout | – | `{ rollout: RolloutState \| null, timeline: AuditEvent[] }` |
| GET | /api/v1/changes/:changeId/resolution | – | `{ resolution: Resolution \| null }`: the merge queue's conflict resolution (resolved head, the `conflict-resolution` item with its diff, upstream Changes, whether a fresh approval is needed) |
| POST | /api/v1/changes/:changeId/kill | `{ reason }` | `{ change: Change }` (flag off + rollback + revert change) |
| GET | /api/v1/changes/:changeId/issues | – | `{ issues: LinkedIssue[] }` |

`GitRemote = { url: string, username: string, token: string, expiresAt: string, branch: string }`
`ChangeSummary = Change & { planTitle: string | null, authorName: string, authorKind: "human" | "agent" }`
`PipelineRun = { id, headSha, engine: "cloudflare-ci" | "workflows", status: "queued"|"running"|"passed"|"failed"|"cancelled"|"superseded", startedAt, finishedAt, steps: { name, status, durationMs, logRef }[] }`
`ChangeDiff = { baseSha, headSha, files: { path, previousPath, status, additions, deletions, binary, transformVerified: boolean, hunks: { header, oldStart, newStart, lines: { kind: "add"|"del"|"ctx", oldNo: number|null, newNo: number|null, text }[] }[] }[] }`
`LinkedIssue = { id, title, count, firstSeen, lastSeen, versionId, url }`

## Audit
| Method | Path | Query | Response |
|---|---|---|---|
| GET | /api/v1/audit | `subject?, cursor?, limit?` | `{ events: AuditEvent[], nextCursor: string \| null, chain: { verified: boolean, brokenAt?: number } }` |

## Webhooks & machine endpoints
- `POST /webhooks/workers-issues` — Workers Issues generic webhook (shared-secret verified).
- `POST /mcp` — MCP server (streamable HTTP). `Authorization: Bearer <token>` takes an MCP OAuth access token
  (discovered from the 401's `resource_metadata`; the CLI's device flow mints one too), an agent token, or an unclaimed
  repo's token (the `token` `create_project` returns without credentials). Without a token only `initialize`,
  `tools/list` (and `ping`), `create_project` and `whoami` are served; anything else answers 401 whose `fix` says to
  reconnect with the token from `create_project`, or to log in. A token whose audience is not the MCP server is a 401
  `invalid_token`.

## Additions (2026-10-01, from building the UI against this contract)

| Method | Path | Response |
|---|---|---|
| GET | /api/v1/principals/:id | `{ principal: Principal & { ownerName?: string } }` |
| GET | /api/v1/blobs/:ref | Raw bytes of an R2-backed reference (`logRef`, `beforeRef`, `afterRef`), with Content-Type; authorized by the repo the ref belongs to |
| GET | /api/v1/changes/:changeId/reviews | `{ reviews: ReviewDecision[] }` |
| GET | /api/v1/repos/:repoId/... | `RepoSummary.counts` gains `plansAwaitingApproval` |

- `ClassifyResult` (in `GET /changes/:id`) is `@app/classifier`'s `ClassifyResult`:
  `{ lane, computedLane, reasons, shadow, blocked, requiresHumanApproval, checklist: { gate, passed: boolean|null, detail }[] }`.
- Responses that carry principal ids (plans, changes, audit, reviews) also include `principals: Record<id, { name, kind, ownerId }>`
  so clients don't need one lookup per id.
- `AuditEvent` responses add `summary: string`, a readable one-liner such as "Stage 25% started" or
  "Error rate 3.1% exceeded the 1.0% limit". It is generated server-side from the payload.
- `Plan` adds `rejectedBy`, `rejectedAt`, `rejectionReason`.
- `ShadowStats.needed` is the number of additional agreeing Lane-0 reviews needed before Lane 0 can be enabled,
  or `null` if that can no longer be reached.
- `GET /changes/:id/rollout` adds `policy: RolloutPolicy`, the rollout policy from the change's **base**, not the repo's current one.
- A tour is stale when `tour.headSha !== change.headSha`. `GET /changes/:id/tour` adds `stale: boolean`.
  Exception: after the merge queue's resolver rewrote the Change, the tour of the resolved head (it leads with
  the resolution) is served and is not stale; `GET /changes/:id/resolution` names that head.
- Policy: an agent's owner may approve that agent's change (allowed, recorded in the audit log). Agents can never hold
  `plan:approve` or `change:review`.
- `ChangeDiff`, `PipelineRun` and `LinkedIssue` are defined by `@app/domain`. Where this document differs, the domain package wins.
