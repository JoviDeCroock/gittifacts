# HTTP API contract (v1)

JSON over HTTPS. All bodies validated with zod; errors are `{ "error": { "code": string, "message": string, "details"?: unknown } }`
with a matching HTTP status. Types refer to `@app/domain` / `@app/evidence`. The OpenAPI document is generated from the
route definitions and served at `GET /api/v1/openapi.json`.

## Auth
- Humans: better-auth session cookie (`/api/auth/*`, GitHub OAuth + email/password, passkeys optional).
- Agents: `Authorization: Bearer <agent token>`; a token belongs to an agent `Principal` (kind `agent`) owned by a human.
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
- `POST /mcp` — MCP server (streamable HTTP), agent bearer token.
