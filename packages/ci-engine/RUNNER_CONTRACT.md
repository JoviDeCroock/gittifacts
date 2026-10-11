# Runner contract (`@app/ci-engine` ⇄ `apps/sandbox`)

This file covers what the CI engine needs from the sandbox image and the `gittifacts-runner` CLI,
and what it guarantees in return. It matches `apps/sandbox/README.md`, which is the source of truth
for the CLI. The engine side lives in `src/runner/runner-do.ts` (the `Runner` Durable Object on
`ctx.container`), `src/runner/markers.ts` (output parsing) and `src/plan/*` (the recorder used by
`plan`). Contract version: 2.

## 1. Image

The image is `apps/sandbox/Dockerfile`, declared as `containers[].images.base` (see §7).

- **Entrypoint.** `tini` + `sleep infinity`. The Runner uses the image's entrypoint and runs
  everything through `exec`.
- **User.** `runner`, uid/gid 10001, home `/home/runner`, workdir `/workspace` (owned by
  `runner`). The Runner runs every workspace exec as `10001:10001`. Only the CA-trust step (§4)
  runs as `0:0`.
- **Tools.** sh (POSIX) and GNU coreutils: `timeout`, `head`, `find`, `wc`. GNU tar, which needs
  `--null -T -` and `-cz`. git ≥ 2.30, for partial clone and `fetch --no-filter`. Node 22+,
  corepack with pnpm and yarn, npm, wrangler, and `ca-certificates` with `update-ca-certificates`.
- **PATH and env.** Every entry point in `/usr/local/bin` sources `/opt/gittifacts/env.sh`. `exec`
  doesn't inherit the image `ENV` except `PATH`, so defaults belong in `env.sh`: store and cache
  paths, `COREPACK_HOME`, and telemetry off.
- **Caches.** `/opt/pnpm-store`, `/opt/npm-cache` and `/opt/yarn-cache` are reused through
  snapshots.
- **No credentials** in the image.
- **Snapshots** cover the whole root filesystem, `/tmp` included. Anything a step writes is
  inherited by the steps that start from it.

## 2. Command environment

Each step runs in its own container. It starts from the image, from its parent step's snapshot, or
from a cached snapshot.

- **cwd.** `/workspace`, or `/workspace/<cwd>`. If the directory is missing, the step fails with
  exit 2 and a message.
- **env.** This is the whole environment.
  - Base: `HOME=/home/runner`, `CI=true`, `LANG=C.UTF-8`, `TERM=dumb`,
    `COREPACK_ENABLE_DOWNLOAD_PROMPT=0`.
  - Then the step's own `env`.
  - Then `GITTIFACTS=1`, `GITTIFACTS_RUN_ID`, `GITTIFACTS_STEP` and `GITTIFACTS_HEAD_SHA`.
  - Evidence steps also get `GITTIFACTS_BASE_SHA` and
    `GITTIFACTS_EVIDENCE_OUT=/tmp/gittifacts/evidence.json`.
  - Under restricted egress, `NODE_EXTRA_CA_CERTS` is added.
- **No secrets, ever.** Steps get no `GITTIFACTS_TOKEN` or `GITTIFACTS_REMOTE`, so the runner
  never needs to fetch missing commits:
  - The checkout exec gets a 15-minute read token through `GIT_CONFIG_*`, and that exec alone.
  - Evidence steps get the base commit pre-fetched with blobs (§3).
- **Timeout.** The step's `timeoutMinutes` (default 25, max 30), bounded by the run's remaining
  `limits.maxMinutes`. The command runs as
  `sh -c "exec timeout --kill-after=10 <secs> sh -c '<cmd>'"`. Exit 124 or 137 means it timed out.
- **Output.** stdout and stderr are combined and redacted (the token, and anything that looks like
  a token). They are streamed to R2 at `ci-logs/<runId>/<step>.log` and capped at
  `limits.maxLogBytes`.
- **Instance.** The step's `instance` (default `standard-2`), clamped to `limits.instance`.

## 3. Workspace

`/workspace` is a shallow, blobless git checkout with a detached `HEAD` at the head commit.
`origin` is the repository remote, and no credentials are stored.

- **Every checkout** rewrites `.git/config` from scratch (a snapshot's copy was written by
  repository code), and runs git with the token in command-scope config only, with
  `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`, `core.hooksPath=/dev/null`,
  `core.fsmonitor=false` and no credential helper (`gitTokenEnv`, `shell.ts`).
- **Fresh container.** `git init`, fetch, checkout.
- **Snapshot at the same commit.** The workspace is untouched, so steps see their parent's
  changes (`node_modules`).
- **Snapshot at another commit** (a cache hit). `git checkout --force` of the new commit;
  untracked and ignored files stay.
- **Evidence steps.** The base commit is also fetched, with blobs. `git worktree add <dir>
  $GITTIFACTS_BASE_SHA` and `git diff base head` work offline. Tracked files are put back to
  `HEAD` (`git reset --hard`) over the parent's snapshot, so evidence measures the commit and not
  what an install script rewrote; untracked and ignored files (`node_modules`) stay.
- **Global-scope cached steps** (install-like steps by default).
  - The command runs with only its cache input files in `/workspace`: no `.git` and nothing else.
  - If it fails that way, the engine runs it again on the full checkout and caches it for that
    repository only.

## 4. Network

- **`open`.** Normal internet access.
- **`registries-only`** (unclaimed projects).
  - The container starts with `enableInternet: false`. Every HTTP and HTTPS request is sent to
    `CiEgressGateway` (`interceptAllOutboundHttp`, `interceptOutboundHttps("*")`).
  - Allowed: `GET`/`HEAD` to `registry.npmjs.org`, `registry.yarnpkg.com`, `repo.yarnpkg.com` and
    `codeload.github.com`, plus git fetch to the repository's git host.
  - Everything else gets a 403 and a line in the step log. Other DNS lookups time out, and
    non-HTTP traffic has no route.
- **TLS interception.** The certificate is `/etc/cloudflare/certs/cloudflare-containers-ca.crt`.
  Before the first command the Runner installs it as root (`update-ca-certificates`) and sets
  `NODE_EXTRA_CA_CERTS`. Tools that ship their own CA bundle are not covered.
- **Plan mode** is limited to the git host whenever the gateway is exported.

## 5. `gittifacts-runner` protocol

- **Logs** go to stderr.
- **Result.** The last stdout line is the result, prefixed with a marker. The engine parses the
  last line that carries the expected marker.
- **Exit codes.**
  - 0 when a document was printed. That includes error items and plan error documents.
  - 2 on a usage error.
  - 1 on a crash.

| Command | Result line |
|---|---|
| `plan [file] [--sha <sha>] [--base <sha>]` | `::plan::<PipelineSpec>` or `::plan::{"error","file"}` |
| `evidence <kind> --base <sha> --head <sha> [--package-manager pm] [--test-command '…']` | `::evidence::<EvidenceItem>` (`transforms` and `policy`: an array) |
| `policy --base <sha> [--head <sha>]` | `::evidence::<PolicyDocument>` (for the coordinator; not a CI step) |
| `diff --base <sha> --head <sha>` | `::evidence::<ChangeDiff>` |
| `preview [--port 8787] [--ip 0.0.0.0] [--dir dist] [--dry-run]` | `::preview::{status,kind,mode,command,url}` once the port answers. Then it runs until wrangler exits. |

### plan

The Runner execs `gittifacts-runner plan '.platform/ci.ts' --sha <sha> --base <sha>`. The exec
runs in a fresh checkout with no `node_modules` and egress limited to the git host, with a 120 s
timeout and at most 512 KiB of stdout. The runner bundles the file with esbuild and records it
with `@app/ci-engine/plan`, using `recordPipeline(resolvePipelineExport(mod))`.

- `::plan::<spec>`: validated with `parsePipelineSpec` and used for the run.
- `::plan::{"error","file"}`: the run fails with `<file>: <error>` shown verbatim. These are author
  errors and are not retried.
- Non-zero exit, a missing marker, or invalid JSON: the run fails with the stderr tail.

### evidence

Kinds: `red-green`, `coverage`, `mutation`, `public-api`, `dependencies`, `transforms`, `policy`.
The CLI also has `sensitive-paths` and `test-run`. `evidence policy` yields the base-policy
sensitive-path item, `id: "policy:sensitive-paths"`.

| CI step | starts from | `requiresGreen` |
|---|---|---|
| `evidence:dependencies`, `evidence:policy` | fresh checkout | no |
| `evidence:red-green`, `evidence:public-api`, `evidence:transforms` | `install` snapshot | no |
| `evidence:coverage`, `evidence:mutation` | `install` snapshot | yes |

The Runner reads `$GITTIFACTS_EVIDENCE_OUT` (JSON, no prefix, ≤ 4 MiB) and nothing else. The
`::evidence::` stdout line is for people and other callers: the step's output also carries
whatever repository code printed, so the Runner never reads evidence from it. A missing file is
an evidence error. The document must be an `EvidenceItem` or an array of up to 50, and is
validated against `@app/evidence`. A failure is recorded as an evidence error, and the classifier
escalates.

**Trust model (security audit 2026-10-11, H3).** Evidence commands run as the same uid (10001)
as repository code, and some of them run that code:

| Kind | Repository code at the evidence step | Forgeable by the Change's code |
|---|---|---|
| `dependencies`, `policy` | none (fresh checkout) | no |
| `public-api`, `transforms` | none in the step; starts from the `install` snapshot (`transforms` runs the BASE script with head's `node_modules`) | `transforms`: yes, through a planted `node_modules`; `public-api`: only through type declarations in `node_modules` |
| `test-run`, `red-green`, `coverage`, `mutation` | the head's tests, test config and test runner plugins, in the same process tree | **yes**: that code can write the evidence file or the reports it is built from |

So Lane 0 trusts the author's test environment for test results, red-green, coverage and
mutation. What the platform recomputes from git in the Worker (sensitive paths, `.platform/**`,
migrations, diff size) can't be reached this way. Closing the rest needs the evidence tool to run
under another uid than the code it measures, with an output directory only it can write, and the
reports it reads produced outside the author's process tree (not done; see DECISIONS.md).

The opt-in `@cloudflare/ci` engine reads only the `::evidence::` line, so with it any evidence
is forgeable by repository code; don't turn on Lane 0 with it. It does not pre-fetch the base
commit; its steps carry `ARTIFACTS_REMOTE` and `ARTIFACTS_TOKEN` (read-only).

### preview

The engine does not run `preview`. The preview host does:

1. It restores `RunSummary.snapshots.build` (the build step's container snapshot). That snapshot
   holds the built workspace and `node_modules`.
2. It runs `gittifacts-runner preview`.
3. It waits for the `::preview::` line.

Rollouts deploy `RunSummary.artifacts.bundle` instead (§6).

## 6. Build artifacts

A step declares `artifacts: [{ name, paths, optional? }]`. The default `build` step declares
`bundle`, taken from `template.json` `buildOutput` when present and otherwise an optional `dist`.

After the command succeeds, the Runner execs `tar -C /workspace -cz -- <paths>` as the runner user.
stdout goes straight to R2 at `ci-artifacts/<runId>/<step>/<name>.tgz`, hashed on the way and
capped at `limits.maxArtifactBytes`. If a path is missing or the archive is too large, the step
fails, unless the artifact is `optional`. Steps with artifacts are always snapshotted.

`RunSummary` reports:

- `artifacts[name] = { key, bytes, sha256, step }`.
- `snapshots[step] = <snapshot id>` for every passed step with a snapshot.

A cached re-run reports the same artifacts and snapshot as the run that filled the cache.

## 7. Platform wiring (`apps/platform`)

The entry module must export `CiRunWorkflow`, `Runner` and `CiEgressGateway` from `@app/ci-engine`.

```jsonc
{
  "compatibility_flags": ["nodejs_compat"],
  "containers": [{
    "class_name": "Runner",
    "scheduling_policy": "durable_object",
    "images": { "base": { "dockerfile": "../sandbox/Dockerfile", "build_context": "../sandbox" } }
  }],
  "durable_objects": { "bindings": [{ "name": "RUNNER", "class_name": "Runner" }] },
  "exports": { "Runner": { "type": "durable-object", "storage": "sqlite" } },
  "workflows": [{ "name": "ci-run", "binding": "CI_RUN_WORKFLOW", "class_name": "CiRunWorkflow" }],
  "r2_buckets": [{ "binding": "CI_BUCKET", "bucket_name": "gittifacts-ci" }],
  "artifacts": [{ "binding": "ARTIFACTS", "namespace": "gittifacts-eu", "remote": true }],
  "vars": { "CI_CACHE_NAMESPACE": "v1" }
}
```

- `COORDINATOR` (optional) is a Durable Object namespace whose stub has
  `onRunFinished(summary: RunSummary)`. It is called once per finished run, keyed by `changeId`.
  Cancelled runs are not reported.
- Select the engine with `selectCiEngine(env, { engine: "workflows" })`. The `@cloudflare/ci`
  engine is opt-in from `@app/ci-engine/cloudflare`.
- **R2 lifecycle.** Keep `ci-artifacts/` for as long as rollouts or reverts may need a bundle, at
  least 30 days. Cached re-runs point at bundles from earlier runs. Expire `ci-cache/` after 30 days
  (snapshots expire then anyway). Expire `ci-logs/` and `ci-evidence/` per retention policy.
- **Snapshot TTL.** Container snapshots live 30 days, and restoring one refreshes that. A preview
  started from an older `snapshots.build` needs the build to run again.
