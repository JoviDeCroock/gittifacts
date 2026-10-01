# Cloudflare Artifacts: API reference (verified 2026-10-01)

Open beta since 2026-10-01, Workers Paid only. Everything below was checked against primary sources on 2026-10-01. The tags in brackets show where each fact came from:

- **[T]** `@cloudflare/workers-types@5.20261001.1` `index.d.ts` (line numbers given; `experimental/index.d.ts` is identical for Artifacts)
- **[W]** `wrangler@4.145.0`: `config-schema.json` and `wrangler-dist/cli.js` (line numbers given)
- **[CLI]** the `cf` CLI v1.0.0-beta.10: `cf schema …`, `--help`, `--dry-run`
- **[D:x]** `https://developers.cloudflare.com/artifacts/x/` (Markdown via `/index.md`)
- **[B1]** blog.cloudflare.com/artifacts-git-for-agents-beta (2026-04-16). **[B2]** /next-git-platform-on-cloudflare (2026-10-01). **[B3]** /ci-workflows (2026-08-04)
- **[CI]** `@cloudflare/ci@0.2.0` source. **[AFS]** github.com/cloudflare/artifact-fs README

## 0. TL;DR for implementers

- **Minimum versions:** `wrangler >= 4.145.0` and `@cloudflare/workers-types >= 5.20260930.1`. The read methods (`readFile`, `readTree`, `readCommit`, `readBlob`, `log`) and the `info()` + `Disposable` handle first appear in 5.20260930.1. Up to 5.20260929.1, `ArtifactsRepo extends ArtifactsRepoInfo`, with metadata as properties. **[T, checked by diffing versions]** **[D:api/workers-binding]**
- **Local dev:** there is no local simulator. The binding always talks to the remote service; set `remote: true` to silence the warning. **[W cli.js:26742, 26677-26690]**
- **The binding and REST API are control plane plus read-only object access.** They cannot write. Commits, ref updates, and notes go over git smart HTTP `git-receive-pack`: a git binary in a container, isomorphic-git in a Worker, or a hand-built receive-pack request (see §5.3). **[T]** **[D:examples/isomorphic-git]** **[D:concepts/repositories]**
- **Push events:** these are repo-level (`artifacts.repo` source). For "every push in a namespace", use a **Workflow trigger** (`triggers.events`, filtered by namespace only). For Queues, the docs only document per-repo subscriptions. **[D:guides/event-subscriptions]** **[D:guides/build-and-deploy-on-push]** **[W]**

## 1. Wrangler config

```jsonc
{
  "artifacts": [
    { "binding": "ARTIFACTS", "namespace": "gittifacts-eu", "remote": true } // required: binding, namespace
  ],
  "workflows": [{ "name": "on-push", "binding": "ON_PUSH", "class_name": "OnPush" }],
  "triggers": {
    "events": [{                                  // [W] config-schema.json:4093-4150, validated cli.js:23532-23620
      "type": "cf.artifacts.repo.pushed",         // one of the 9 ArtifactsEventType values (§7)
      "filter": { "namespace": "gittifacts-eu" }, // optional; keys ONLY "namespace" | "repo_name" (strings)
      "targets": [{ "type": "workflow", "workflow_name": "on-push" }] // non-empty; target type must be "workflow"
    }]
  }
}
```

- `artifacts` is **not inherited** by named envs. `PreviewsConfig` also accepts `artifacts`. **[W config-schema.json:1489,3339,5517]**
- A trigger's target workflow **must be defined by the same Worker**, or deploy fails. **[W cli.js:160713-160730]**
- On deploy, wrangler calls `PUT /accounts/{account_id}/triggers/{script_name}` with the `events` array and adds `script_name` to each target. **[W cli.js:160436-160460]**
- `npx wrangler types` generates `ARTIFACTS: Artifacts`.

## 2. Workers binding: the TypeScript surface [T index.d.ts:12441-12782]

```ts
interface Artifacts {                                        // :12712
  create(name: string, opts?: { readOnly?: boolean; description?: string; setDefaultBranch?: string })
    : Promise<ArtifactsCreateRepoResult>;                    // :12721
  get(name: string): Promise<ArtifactsRepo>;                 // :12738  throws NOT_FOUND | CREATE_/IMPORT_/FORK_IN_PROGRESS
  import(params: {                                           // :12752  any public HTTPS git remote
    source: { url: string; branch?: string; depth?: number };
    target: { name: string; opts?: { description?: string; readOnly?: boolean } };
  }): Promise<ArtifactsCreateRepoResult>;
  list(opts?: { limit?: number /*1-200, def 50*/; cursor?: string }): Promise<ArtifactsRepoListResult>; // :12770
  delete(name: string): Promise<boolean>;                    // :12780  also deletes all tokens; false if not found
}
interface ArtifactsRepo extends Disposable {                 // :12574  RPC stub: `using repo = await env.ARTIFACTS.get(n)`
  createToken(scope?: "write" | "read" /*def write*/, ttl?: number /*s, def 86400, 60..31536000*/)
    : Promise<ArtifactsCreateTokenResult>;                   // :12581
  listTokens(): Promise<ArtifactsTokenListResult>;           // :12586
  revokeToken(tokenOrId: string): Promise<boolean>;          // :12593
  info(): Promise<ArtifactsRepoInfo>;                        // :12600  fresh lookup each call
  readBlob(hash: string): Promise<Blob | null>;              // :12609  untyped Blob; null if missing/not blob
  readTree(hash: string): Promise<ArtifactsTreeEntry[] | null>;          // :12618  immediate children only
  readCommit(hash: string): Promise<ArtifactsCommitMetadata | null>;     // :12627
  readFile(args: { ref: string; path: string }): Promise<Blob | null>;   // :12638  ref = branch|tag|sha; MIME-typed
  log(opts?: { ref?: string /*HEAD*/; limit?: number /*50, max 1000*/; offset?: number })
    : Promise<ArtifactsCommitMetadata[]>;                    // :12649  first-parent chain, newest first; [] if bad ref
  fork(name: string, opts?: { description?: string; readOnly?: boolean; defaultBranchOnly?: boolean /*def true*/ })
    : Promise<ArtifactsCreateRepoResult>;                    // :12663  throws FORK_IN_PROGRESS
}
interface ArtifactsRepoInfo { id: string; name: string; description: string | null; defaultBranch: string;
  createdAt: string; updatedAt: string; lastPushAt: string | null;
  source: string | null /* "github:owner/repo" | "artifacts:ns/repo" */; readOnly: boolean; remote: string }
interface ArtifactsCreateRepoResult { id; name; description: string | null; defaultBranch; remote: string; token: string }
interface ArtifactsRepoListResult { repos: Omit<ArtifactsRepoInfo, "remote">[]; total: number; cursor?: string }
interface ArtifactsCreateTokenResult { id: string; plaintext: string; scope: "read" | "write"; expiresAt: string }
interface ArtifactsTokenInfo { id; scope: "read" | "write"; state: "active" | "expired" | "revoked"; createdAt; expiresAt }
interface ArtifactsTokenListResult { tokens: ArtifactsTokenInfo[]; total: number }
type ArtifactsTreeEntryType = "tree" | "blob" | "symlink" | "gitlink" | "exec";
interface ArtifactsTreeEntry { name: string; mode: string /* "100644","40000" */; hash: string; type: ArtifactsTreeEntryType }
interface ArtifactsCommitMetadata { hash; treeHash; message; author: { name; email }; committer: { name; email };
  parents: string[]; authoredAt: number /*unix s*/; committedAt: number }
interface ArtifactsError extends Error { name: "ArtifactsError"; code: ArtifactsErrorCode; numericCode: number } // :12699
```

**Capability answers**

| Need | Binding? | How |
|---|---|---|
| create, get, list, delete | yes | above |
| import from GitHub | yes | `import({source:{url,branch?,depth?}, target:{name, opts?}})`. Public HTTPS only (`REMOTE_AUTH_REQUIRED` 10106). Works for any HTTPS git host (GitLab is shown in [D:api/rest-api]). Async: `get()` throws `IMPORT_IN_PROGRESS`, REST returns 409; retry. |
| fork with readOnly | yes | Fork is on the **handle**: `(await env.ARTIFACTS.get(src)).fork(dst, { readOnly: true, defaultBranchOnly: false })` |
| repo-scoped token | yes | `repo.createToken("read" \| "write", ttlSeconds)`. `create/import/fork` also return an initial `token` (scope/TTL not documented) |
| git notes read/write | **no API** | Notes are ordinary refs (`refs/notes/*`). Push/fetch them over git [D:concepts/best-practices]. Reading via `readFile({ref:"refs/notes/commits", path:<sha>})` is untested (§11) |
| read/list refs | partial | No `listRefs`. Branch head: `(await repo.log({ref:"main",limit:1}))[0]?.hash`. Full ref list: git `info/refs` / `ls-refs` (§5) |
| update a ref or fast-forward | **no** | Only via `git-receive-pack` (§5.3) |
| commits, trees, blobs | yes | `readCommit`, `readTree`, `readBlob`, `readFile`, `log` |
| diffs | **no** | Walk two trees with `readTree`, compare entry hashes, `readBlob` the changed ones, diff in JS |

Docs also say `list()` items carry `status: "ready" | "importing" | "forking"`, but the type `Omit<ArtifactsRepoInfo,"remote">` has no `status` [D:api/workers-binding vs T].

## 3. REST API [D:api/rest-api] [CLI schema] [W cli.js:211660-211740]

Base `https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/artifacts`. Auth: `Authorization: Bearer $CF_API_TOKEN` with permission **Artifacts Read** for GET routes or **Artifacts Edit** for writes. Responses use the v4 envelope `{result,success,errors,messages,result_info?}`. Bodies are **snake_case**.

| Op | Method + path (under `/artifacts`) | Body / query |
|---|---|---|
| Create namespace | `POST /namespaces` | `{namespace, jurisdiction?: "eu"\|"us"}` (default unrestricted) |
| List / get / delete namespace | `GET /namespaces?limit&cursor`, `GET\|DELETE /namespaces/:ns` | list items: `{namespace,jurisdiction,repo_count,created_at,updated_at}` [CLI live] |
| Create repo | `POST /namespaces/:ns/repos` | `{name, description?, default_branch?, read_only?}` → `{id,name,description,default_branch,remote,token}` |
| List repos | `GET /namespaces/:ns/repos` | `limit`(≤200), `cursor`, `search`, `sort=created_at\|updated_at\|last_push_at\|name`, `direction=asc\|desc` |
| Get / delete repo | `GET\|DELETE /namespaces/:ns/repos/:name` | DELETE returns **202** `{id}` |
| Fork | `POST /namespaces/:ns/repos/:src/fork` | `{name /*target*/, description?, read_only?, default_branch_only?}` → create result + `objects` |
| Import | `POST /namespaces/:ns/repos/:name/import` | `{url, branch?, depth?, read_only?}` (target name is in the path) |
| Log | `GET /namespaces/:ns/repos/:name/log?ref&limit&offset` | JSON (shape not documented) |
| Commit / tree | `GET …/repos/:name/commit/:sha`, `…/tree/:sha` | JSON, "cacheable forever by hash" [CLI help] |
| Blob | `GET …/repos/:name/blob/:sha` | raw bytes |
| File | `GET …/repos/:name/file?ref=&path=` | raw bytes, `application/octet-stream` |
| Raw | `GET …/repos/:name/raw/:ref/:path` | bytes with a sniffed Content-Type and browser-safe headers |
| List tokens | `GET …/repos/:name/tokens?state=active\|expired\|revoked\|all&page&per_page(≤100)` | offset paging |
| Mint token | `POST /namespaces/:ns/tokens` | `{repo, scope?: "read"\|"write" (def write), ttl?: 60..31536000 (def 86400)}` → `{id,plaintext,scope,expires_at}` |
| Revoke token | `DELETE /namespaces/:ns/tokens/:id` | id matches `/^[0-9a-z]{16}$/`. The index is eventually consistent, so a revoke within about 1s of minting can 404; retry [CLI help] |

```bash
B=https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/artifacts
curl -X POST "$B/namespaces" -H "Authorization: Bearer $CF_API_TOKEN" --json '{"namespace":"gittifacts-eu","jurisdiction":"eu"}'
curl -X POST "$B/namespaces/gittifacts-eu/repos/base/fork" -H "Authorization: Bearer $CF_API_TOKEN" \
  --json '{"name":"task-123","read_only":false,"default_branch_only":true}'
curl -X POST "$B/namespaces/gittifacts-eu/tokens" -H "Authorization: Bearer $CF_API_TOKEN" \
  --json '{"repo":"task-123","scope":"write","ttl":3600}'
curl "$B/namespaces/gittifacts-eu/repos/task-123/raw/main/README.md" -H "Authorization: Bearer $CF_API_TOKEN"
```

The `cf` CLI equivalents are `cf artifacts namespaces {create|list|get|delete}`, `cf artifacts namespaces repos {create|list|get|delete|fork|import}`, `… repos {blobs|commits|trees|files|raw|logs} get`, `… repos tokens list`, and `cf artifacts namespaces tokens {create|revoke}`. Gotcha: the CLI's fork schema **omits the target `name`**. Pass it with `--body '{"name":"dst",…}'` (confirmed with `--dry-run`).

Wrangler: `wrangler artifacts namespaces {list,get}` and `wrangler artifacts repos {create,list,get,delete,issue-token}`. These are still marked "private beta" in 4.145.0 [W cli.js:211792-212140].

## 4. Namespaces and jurisdiction

- Namespaces are created **implicitly** by the first repo create, and implicit ones are always **unrestricted**. For EU you must create the namespace explicitly first: `POST /namespaces {"namespace":…,"jurisdiction":"eu"}`. The jurisdiction is **immutable** [D:guides/data-localization] [D:changelog 2026-08-13].
- Documented values are `eu` and `us`. Leaving it out gives unrestricted. `cf artifacts namespaces create --jurisdiction` also offers `unrestricted|us|eu|fedramp`; `fedramp` is undocumented [CLI help].
- A binding names exactly one namespace, so it cannot set or inspect jurisdiction. Use one binding per namespace.
- Naming: 2-63 chars [D:platform/limits]. Must start with a letter or digit; the rest may be letters, digits, `.`, `_`, `-`. The same rules apply to repos (repo max length is not documented).
- This account currently has one namespace, `keelhaul` (unrestricted, 164 repos). It belongs to another project; do not use it [CLI `namespaces list`].

## 5. Git smart HTTP [D:api/git-protocol] [D:guides/authentication]

- **Remote:** `https://<ACCOUNT_ID>.artifacts.cloudflare.net/git/<namespace>/<repo>.git`. Always use the `remote` the API returns.
- **Token format:** `art_v1_<40 hex>?expires=<unix_seconds>`.
  - **Bearer** (recommended): `git -c http.extraHeader="Authorization: Bearer $FULL_TOKEN" clone "$REMOTE"`. Takes the full string, suffix included.
  - **Basic**: `https://x:${TOKEN%%\?expires=*}@<host>/git/ns/repo.git`. The password is the secret **without** `?expires=`. The username is ignored but must be non-empty.
- **Scopes:** `read` allows clone, fetch, pull. `write` adds push. Cloudflare API tokens do **not** work for git.
- **Protocol support:**
  - `git-upload-pack` (clone/fetch): v1 and v2 (`ls-refs`, `fetch`, shallow/deepen). Some optional v1 capabilities are **unsupported**, e.g. `filter` and `include-tag`.
  - `git-receive-pack` (push): **v1 only**; v2 receive-pack is unsupported.
- **Endpoints** (standard smart HTTP): `GET {remote}/info/refs?service=git-upload-pack|git-receive-pack`, `POST {remote}/git-upload-pack`, `POST {remote}/git-receive-pack`.

### 5.1 Writing from a Worker (documented): isomorphic-git + in-memory fs [D:examples/isomorphic-git]

```ts
import git from "isomorphic-git"; import http from "isomorphic-git/http/web";
await git.push({ fs, http, dir, url: created.remote, ref: "main",
  onAuth: () => ({ username: "x", password: created.token.split("?expires=")[0] }) });
```

### 5.2 Notes (git CLI in a container/sandbox) [D:concepts/best-practices] [B1 "native support for git-notes"]

```bash
git notes --ref=refs/notes/agent add -m '{"run":"r1","model":"…"}' HEAD
git push origin 'refs/notes/*:refs/notes/*'      # write token
git fetch origin 'refs/notes/*:refs/notes/*'
```

### 5.3 Ref update / fast-forward without objects: raw receive-pack (standard git protocol, **untested against Artifacts**)

```ts
// FF refs/heads/main from OLD to NEW, where NEW already exists in the repo (e.g. a pushed PR branch tip).
const enc = new TextEncoder();
const pkt = (s: string) => { const b = enc.encode(s); return [enc.encode((b.length + 4).toString(16).padStart(4, "0")), b]; };
const hdr = new Uint8Array([0x50,0x41,0x43,0x4b, 0,0,0,2, 0,0,0,0]);          // "PACK", v2, 0 objects
const emptyPack = new Uint8Array([...hdr, ...new Uint8Array(await crypto.subtle.digest("SHA-1", hdr))]);
const body = new Blob([...pkt(`${OLD} ${NEW} refs/heads/main\0report-status agent=gittifacts\n`), enc.encode("0000"), emptyPack]);
const res = await fetch(`${remote}/git-receive-pack`, { method: "POST", body, headers: {
  Authorization: `Bearer ${writeToken}`, "Content-Type": "application/x-git-receive-pack-request",
  Accept: "application/x-git-receive-pack-result" } });
// Expect pkt-lines "unpack ok" + "ok refs/heads/main". OLD must match the current tip, giving compare-and-swap semantics.
// Deleting a ref: NEW = 40 zeros, and send no pack at all.
```

## 6. Events [D:guides/event-subscriptions] [D: queues/event-subscriptions/events-schemas] [W config-schema.json:4138]

| Event type | Source to subscribe | Payload |
|---|---|---|
| `cf.artifacts.repo.created` / `.deleted` | `artifacts` (account-level) | `{repoId, defaultBranch, description, readOnly, createdAt, updatedAt, lastPushAt}` |
| `cf.artifacts.repo.forked` | `artifacts` | the above plus `namespace, repoName` of the **target**. `source` = the fork origin |
| `cf.artifacts.repo.imported` | `artifacts` | the above plus `sourceUrl, branch` |
| `cf.artifacts.repo.pushed` | `artifacts.repo` (repo-level: `namespace` + `repo_name`) | see below |
| `cf.artifacts.repo.cloned` / `.fetched` | `artifacts.repo` | `{}` |
| `cf.artifacts.repo.token.created` | `artifacts.repo` | `{tokenId, scope, expiresAt}` |
| `cf.artifacts.repo.token.revoked` | `artifacts.repo` | `{tokenId}` |

```json
{ "type": "cf.artifacts.repo.pushed",
  "source": { "type": "artifacts.repo", "namespace": "my-namespace", "repoName": "my-repo" },
  "payload": { "ref": "refs/heads/main", "before": "<40-hex>", "after": "<40-hex>",
    "commits": [{ "id": "<sha>", "message": "…", "messageTruncated": false, "timestamp": "2025-05-01T02:48:57.000Z",
      "author": {"name":"…","email":"…"}, "committer": {"name":"…","email":"…"}, "parents": ["<sha>"] }],
    "totalCommitsCount": 1, "commitsTruncated": false },
  "metadata": { "accountId": "…", "eventSubscriptionId": "…", "eventSchemaVersion": 1, "eventTimestamp": "…" } }
```

The payload has a single `ref` with `before`/`after`. A branch delete arrives with `after` = 40 zeros; [CI] `events.ts:50-64` skips those, and also skips refs that are neither `refs/heads/*` nor `refs/tags/*`. There is no `forced` flag.

**Delivery option A: Queues event subscription.** The API is `POST /accounts/{id}/event_subscriptions/subscriptions` [W cli.js:343931-343950]:

```bash
npx wrangler queues subscription create gittifacts-events --source artifacts --events cf.artifacts.repo.created,cf.artifacts.repo.forked
# repo-level (push): docs require namespace+repo_name. Wrangler 4.145.0 sends only {type}, so use the raw API:
curl -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/event_subscriptions/subscriptions" \
  -H "Authorization: Bearer $CF_API_TOKEN" --json '{"name":"push-task-123","enabled":true,
  "source":{"type":"artifacts.repo","namespace":"gittifacts-eu","repo_name":"task-123"},
  "destination":{"type":"queues.queue","queue_id":"<QUEUE_ID>"},"events":["cf.artifacts.repo.pushed"]}'
```

Consumer: `async queue(batch, env) { for (const m of batch.messages) { const e = m.body; if (e.type === "cf.artifacts.repo.pushed") … } }` [B2]. The `cf queues subscriptions create --source-type` choices do not list `artifacts`/`artifacts.repo` (stale OpenAPI), so use `--body` [CLI].

**Delivery option B: Workflow trigger** (config in §1). This is the only documented **namespace-wide push** fan-out. Each push starts one Workflow instance, and the Artifacts event object is passed as `event.payload` (verified in [CI] `ci-workflow.ts:78-110` + `artifacts/events.ts:17-31`):

```ts
export class OnPush extends WorkflowEntrypoint<Env, ArtifactsPushEvent> {
  async run(event: WorkflowEvent<ArtifactsPushEvent>, step: WorkflowStep) {
    const { source: { namespace, repoName }, payload: { ref, before, after } } = event.payload; … } }
```

## 7. ArtifactFS [D:guides/artifact-fs] [AFS] [B1]

- A Go FUSE daemon, `github.com/cloudflare/artifact-fs` (Apache-2.0, beta). It does a **blobless clone**: commits, trees, and refs first, then mounts and hydrates blobs on read, prioritizing manifests and source over binaries. The mount is writable through a copy-on-write overlay, and git commit/push work inside it. It works with any git remote. Needs Go 1.26+ and FUSE (`fuse3` on Linux, macFUSE on macOS).
- **Caveat:** on-demand hydration requires the remote to advertise partial-clone `filter`. Otherwise git downloads the revision's blobs eagerly [AFS "Verified shallow sources"]. Artifacts says v1 `filter` is unsupported, and its v2 filter support is undocumented (§11).

```bash
go install github.com/cloudflare/artifact-fs/cmd/artifact-fs@latest
artifact-fs add-repo --name task-123 --remote "https://x:${TOKEN%%\?expires=*}@${REMOTE#https://}" --branch main --mount-root /workspace
artifact-fs daemon --root /workspace &      # flags: --hydration-concurrency N; add-repo: --async (needs a credential helper, no inline creds), --depth, --require-commit <sha>, --refresh never
artifact-fs status --name task-123
```

- **Containers:** `docker run --cap-add SYS_ADMIN --device /dev/fuse …`. The Cloudflare Sandbox example builds `FROM docker.io/cloudflare/sandbox:0.12.5` with `fuse3 git` plus the `artifact-fs` binary (`examples/cloudflare-sandbox-sdk/Dockerfile`). For plain sandboxes the docs pass `ARTIFACTS_GIT_REMOTE` (an authenticated URL) via `sandbox.setEnvVars` [D:examples/sandbox-sdk-artifacts].

## 8. Limits, pricing, metrics

**Limits** [D:platform/limits]:
- Control plane: 2,000 req / 10 s **per namespace**.
- Git: 2,000 req / 10 s **per repo**.
- 1 GB per repo; 32 MB max file/blob; 1 TB per account (can be raised).
- Unlimited repos and namespaces.
- `log` limit ≤ 1000; `list` limit ≤ 200 [T].
- Memory-heavy operations can throw `MEMORY_LIMIT` (each repo is a Durable Object with about 128 MB [B1]).

**Pricing** [D:platform/pricing] [B1]:
- Workers Paid only.
- Operations: first 10,000/month included, then **$0.15 per 1,000**.
- Storage: first 1 GB-month included, then **$0.50 per GB-month** (average of daily peak; replicas are free).
- Billing start: **October 14, 2026** per the docs (pricing page and changelog), but **October 15, 2026** per [B2].
- Which binding calls count as "operations" (e.g. `readFile`, `log`, `createToken`) is not specified.

**Metrics:** GraphQL dataset `artifactsEventsAdaptiveGroups`, with `eventType` values `create|fork|push|pull|delete` and errors `storageLimitReached|serverError|clientError|rateLimited`; 31-day retention [D:observability/metrics].

**Errors** [D:api/errors]:

| Code | Name |
|---|---|
| 10100 | INVALID_INPUT |
| 10101 | INVALID_REPO_NAME |
| 10103 | INVALID_TTL |
| 10104 | INVALID_URL |
| 10106 | REMOTE_AUTH_REQUIRED |
| 10200 | NOT_FOUND |
| 10201 | ALREADY_EXISTS |
| 10302 | IMPORT_IN_PROGRESS |
| 10303 | FORK_IN_PROGRESS |
| 10400 | INTERNAL_ERROR |
| 10401 | UPSTREAM_UNAVAILABLE |
| 10402 | MEMORY_LIMIT |

The binding also has `CREATE_IN_PROGRESS` (no numeric code documented).

## 9. Discrepancies vs the prompt's summary

The prompt said: *"create, get, import (from GitHub), fork({ readOnly }), repo-scoped tokens, git smart HTTP v1/v2, git-notes. Namespaces choose a US or EU jurisdiction."*

1. **fork is not a namespace method.** It is `ArtifactsRepo.fork(name, {readOnly, description, defaultBranchOnly})` on the handle returned by `get()`. `defaultBranchOnly` defaults to **true** (only the default branch is copied) [T:12663].
2. **import is not GitHub-specific.** It accepts any **public** HTTPS git remote; there is no private-repo import. It is asynchronous.
3. **"git smart HTTP v1/v2" holds only for fetch/clone.** Push is **receive-pack v1 only**, and the v1 `filter`/`include-tag` capabilities are unsupported.
4. **git-notes have no API** (binding or REST). The "native support" claim [B1] means the server stores and serves `refs/notes/*` over git. Agents must push them with git.
5. **Jurisdiction is optional** and defaults to unrestricted. It is immutable, and it is set only by **explicitly creating the namespace** first (implicit creation = unrestricted). The binding cannot set it. The CLI also lists `fedramp`.
6. **Missing from the summary:**
   - read APIs: `readFile`, `readTree`, `readCommit`, `readBlob`, `log` (binding and REST, including `raw/:ref/:path`)
   - `list`/`delete`, `listTokens`/`revokeToken`
   - events plus Workflow triggers
   - the **lack of any ref-write, merge, or diff API**
7. Billing date is Oct 14 (docs) vs Oct 15 (blog), as noted in §8.

## 10. Other inconsistencies found in the sources

- **`triggers.events` shape.** [D:guides/build-and-deploy-on-push] and [B3] show `filter.repoName` and a singular `target:{scriptName,workflowName}` / `target:{type,workflow_name}`. **wrangler 4.145.0 rejects these.** It requires `filter.repo_name` and `targets:[{type:"workflow",workflow_name}]` [W cli.js:23580-23620]. Use the wrangler shape.
- **Stale handle properties.** The [D:examples/sandbox-sdk-artifacts] and [D:concepts/best-practices] snippets read `repo.defaultBranch`/`repo.remote` off the handle and skip `using`. Since types 5.20260930.1 you must call `await repo.info()`.
- **Stale endpoints in the 2026-04-16 changelog.** `https://artifacts.cloudflare.net/v1/api/...` and `artifacts.cloudflare.net/<ns>/<repo>.git` are obsolete. Current: `api.cloudflare.com/client/v4/.../artifacts` and `<acct>.artifacts.cloudflare.net/git/<ns>/<repo>.git`.
- **Outdated statement in [D:examples/isomorphic-git].** It says the binding "cannot read or write files inside them". Reads now exist; writes still don't.
- **`@cloudflare/ci` comment.** It says the hash-read methods are missing from workers-types. That is now outdated (they were added in 5.20260930.1).

## 11. Open questions / unverifiable without creating resources

Creating resources was off-limits, and the only namespace (`keelhaul`) belongs to another project. Each item lists how to verify it.

1. **Partial clone.** Does v2 `fetch` advertise `filter` (blobless clone, i.e. ArtifactFS lazy hydration)? Test: `GIT_TRACE_PACKET=1 git -c protocol.version=2 ls-remote <remote>`, then `git clone --filter=blob:none`.
2. **Notes from a Worker.** Does `readFile`/`log` accept full ref names like `refs/notes/commits`? Note paths may be fanned out (`ab/cdef…`). Fallback: `log({ref:"refs/notes/commits"})` → `readCommit` → `readTree` walk.
3. **Raw receive-pack (§5.3).** Are empty-pack updates, ref deletes, `atomic`, and `push-options` accepted? What happens on non-FF without force? Is there any branch protection? None is documented, so plan for none.
4. **Push event granularity.** Does a multi-ref push emit one event per ref? Do `refs/notes/*` and tag pushes emit `pushed`? What are the commit-list truncation limits?
5. **Queues namespace-wide push.** Can `artifacts.repo` subscriptions omit `repo_name` (or `namespace`)? Wrangler sends `{type}` only. Can the account-level `artifacts` source carry `pushed`? Delivery guarantees (at-least-once?) and ordering are undocumented.
6. **REST read shapes.** JSON for `/log`, `/commit/:sha`, `/tree/:sha` is undocumented (camelCase like the binding, or snake_case?).
7. **Initial tokens.** What scope and TTL does the token returned by `create`/`import`/`fork` have? The examples suggest write.
8. **Repo name limits.** Max length is undocumented. Do `/` or uppercase-sensitive collisions apply?
9. **Read-only repos.** Is `readOnly` changeable after creation? There is no update endpoint, so probably not. Does a push with a write token to a read-only repo fail?
10. **Billing scope.** Do binding reads, token mints, and git `ls-refs` count as billable operations? Does the control-plane rate limit include binding calls?
11. **Git LFS.** Mentioned as an "extensible" goal [B1]; not documented as supported.
12. **Event triggers API.** The REST shape of `PUT /accounts/{id}/triggers/{script}` is not in the `cf` CLI schema list. It is known only from wrangler source.
