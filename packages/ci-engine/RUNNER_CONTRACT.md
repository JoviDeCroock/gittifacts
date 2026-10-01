# Runner contract (`@app/ci-engine` ⇄ `apps/sandbox`)

What the CI engine needs from the sandbox image and the `gittifacts-runner` CLI, and what it
guarantees in return. The engine side is `src/runner/runner-do.ts` (the `Runner` Durable Object on
`ctx.container`) and `src/plan/*` (plan mode). Contract version: 1.

## 1. Image

Built from `apps/sandbox/Dockerfile` and declared as `containers[].images.base` (see §6).

| Requirement | Why |
|---|---|
| Debian/Ubuntu base, runs as root | `update-ca-certificates`, writable `/usr/local/share/ca-certificates` |
| `sh` (POSIX), GNU coreutils (`timeout`, `sleep infinity`, `head -c`, `mv`, `find`, `wc`) | every command runs as `sh -c "exec timeout --kill-after=10 <secs> sh -c '<cmd>'"`; the Runner starts the container with entrypoint `["sleep", "infinity"]` |
| GNU tar (`--null -T -`) | global-scope cached steps reduce `/workspace` to their cache inputs |
| git ≥ 2.30 (partial clone, `fetch --no-filter`) | checkout (§3) |
| `ca-certificates` with `update-ca-certificates` | restricted egress intercepts TLS (§4) |
| Node.js 22+ with corepack enabled (pnpm and yarn shims), npm | default pipelines run `pnpm install --frozen-lockfile`, `npm ci`, `yarn install …` |
| bun (optional) | only for repos with `bun.lock` |
| every tool on the default `PATH` (`/usr/local/bin`, `/usr/bin`, …) | `exec` does not inherit the image `ENV` except `PATH` |
| `gittifacts-runner` on `PATH` (§5) | plan mode and evidence steps |
| writable `/workspace` and `/tmp` | checkout target; evidence output goes to `/tmp/gittifacts/` |

The image must not contain credentials. Snapshots are root-filesystem snapshots, so anything a
step writes anywhere (including `/tmp`) is inherited by steps that start from it.

## 2. Command environment

Each step runs in its own container, started from the image or from its parent step's snapshot.

- **cwd**: `/workspace`, or `/workspace/<cwd>` for steps with a `cwd` (a missing directory is the
  step's failure: exit 2 with a message).
- **env** (nothing else; the image env is not inherited except `PATH`):
  `HOME=/root CI=true LANG=C.UTF-8 TERM=dumb COREPACK_ENABLE_DOWNLOAD_PROMPT=0`, the step's own
  `env`, then `GITTIFACTS=1 GITTIFACTS_RUN_ID GITTIFACTS_STEP GITTIFACTS_HEAD_SHA`, and for evidence
  steps also `GITTIFACTS_BASE_SHA GITTIFACTS_EVIDENCE_OUT=/tmp/gittifacts/evidence.json`. Under
  restricted egress also `NODE_EXTRA_CA_CERTS`.
- **No secrets.** The only credential is a 15-minute read token for the repository, and only the
  checkout exec sees it (as `GIT_CONFIG_*` env). Commands never get it.
- **Timeout**: the step's `timeoutMinutes` (default 25, max 30), further bounded by the run's
  remaining `limits.maxMinutes`. `timeout` sends SIGTERM, then SIGKILL 10 s later; exit 124/137 is
  reported as timed out.
- **Output**: stdout and stderr combined, redacted (the token and anything token-shaped), streamed
  to R2 at `ci-logs/<runId>/<step>.log`, capped at `limits.maxLogBytes` (default 20 MiB).
- **Instance**: the step's `instance` (default `standard-2`), clamped to `limits.instance`.

## 3. Workspace

`/workspace` is a git working tree: shallow (`--depth=1`), blobless fetch, detached `HEAD` at the
head commit, `origin` = the repository remote, no credentials stored.

- Fresh container: `git init`, fetch, checkout.
- From a snapshot at the same commit: untouched (a step sees its parent's changes, e.g.
  `node_modules`).
- From a snapshot at another commit (a cache hit): `git checkout --force` of the new commit over it;
  untracked and ignored files (e.g. `node_modules`) stay.
- Evidence steps: the base commit is fetched too, with blobs (`git cat-file`/`git diff base head`
  and `git worktree add <dir> $GITTIFACTS_BASE_SHA` work offline).
- Global-scope cached steps (install-like steps by default): the command runs with **only its
  cache input files** in `/workspace` (no `.git`, nothing else). Install must not read other
  repository files; if it fails that way the engine re-runs it on the full checkout and caches it
  per repository.

## 4. Network

- `open`: normal internet access.
- `registries-only` (unclaimed projects): the container starts with `enableInternet: false`, and
  every HTTP and HTTPS request is intercepted (`interceptAllOutboundHttp`,
  `interceptOutboundHttps("*")`) and sent to `CiEgressGateway`. Allowed: `GET`/`HEAD` to
  `registry.npmjs.org`, `registry.yarnpkg.com`, `repo.yarnpkg.com`, `codeload.github.com`, and git
  fetch (`info/refs?service=git-upload-pack`, `git-upload-pack`) to the repository's git host.
  Everything else gets `403` with an explanation, and a line in the step log. DNS for other hosts
  times out; non-HTTP protocols have no route.
- HTTPS interception terminates TLS with a Cloudflare CA at
  `/etc/cloudflare/certs/cloudflare-containers-ca.crt`. Before the first command the Runner copies it
  into `/usr/local/share/ca-certificates/` and runs `update-ca-certificates`, and sets
  `NODE_EXTRA_CA_CERTS`. Tools with their own CA bundle (Python `certifi`, Java) are not covered.
- Plan mode always runs with egress limited to the git host when the gateway is exported.

## 5. `gittifacts-runner` CLI

### `gittifacts-runner plan <file> --sha <sha> [--base <sha>]`

Evaluates the pipeline file (`.platform/ci.ts`) in plan mode.

- Load the module without installing dependencies (Node's type stripping or a bundled loader).
  `node_modules` is **not** installed, and the network reaches only the git host.
- Implement with `@app/ci-engine/plan`:
  `recordPipeline(resolvePipelineExport(mod), { context: { sha, baseSha } })`.
- stdout: exactly one JSON document, the `PipelineSpec` (≤ 512 KiB). stderr: diagnostics.
- Exit 0 on success. On author errors (`PlanError`, a throw, an invalid DAG) exit non-zero with a
  readable message on stderr; it is shown to the author verbatim (last 4 KiB).
- Time limit: 120 s.

### `gittifacts-runner evidence <kind> --base <sha> --head <sha> [--package-manager <pm>] [--test-command '<cmd>']`

`<kind>` ∈ `red-green | coverage | mutation | public-api | dependencies | transforms | policy`. The
shell expands `--base "$GITTIFACTS_BASE_SHA" --head "$GITTIFACTS_HEAD_SHA"`.

| kind | starts from | `requiresGreen` | output (`@app/evidence`) |
|---|---|---|---|
| `dependencies` | fresh checkout | no | `DependencyDiff` (`id: "dependencies"`) |
| `policy` | fresh checkout | no | `SensitivePathHits` using the **base** `.platform/policy.ts` |
| `red-green` | `install` snapshot | no | `RedGreenProof` (`verdict: "no-tests"` when there are none) |
| `coverage` | `install` snapshot | yes | `CoverageDelta` on changed lines |
| `mutation` | `install` snapshot | yes | `MutationScore` on changed lines |
| `public-api` | `install` snapshot | no | `PublicApiDiff` (`.d.ts` diff) |
| `transforms` | `install` snapshot | no | one `ReproducibleTransform` per `.platform/transforms/*` |

Output, both channels:

1. Write one JSON document, an `EvidenceItem` or an array of up to 50, to
   `$GITTIFACTS_EVIDENCE_OUT` (≤ 4 MiB). The engine validates it against `@app/evidence`.
2. Print the same document as the **last stdout line**, prefixed `::evidence::` (compact JSON). The
   opt-in `@cloudflare/ci` engine has no file channel and reads only this line.

Exit 0 when the measurement worked, whatever the verdict. When it could not measure, still emit an
item with `status: "error"` and a `note`, then exit non-zero. No output at all is recorded as an
evidence error, and the classifier escalates (unknown → escalate).

Under the `@cloudflare/ci` engine the base commit is not pre-fetched. The command env then carries
`ARTIFACTS_REMOTE` and `ARTIFACTS_TOKEN` (read-only); fetch the base with
`git -c http.extraHeader="Authorization: Bearer $ARTIFACTS_TOKEN" fetch --depth=1 origin "$GITTIFACTS_BASE_SHA"`.

## 6. Platform wiring (`apps/platform`)

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

- `COORDINATOR` (optional): a Durable Object namespace whose stub has
  `onRunFinished(summary: RunSummary)`; called once per finished run, keyed by `changeId`. Cancelled
  runs are not reported (the caller cancelled them).
- Build engines with `selectCiEngine(env, { engine: "workflows" })`. The `@cloudflare/ci` engine is
  opt-in from `@app/ci-engine/cloudflare` and needs its own bindings.
- R2 lifecycle rules: expire `ci-logs/` and `ci-evidence/` per retention policy, and `ci-cache/`
  after 30 days (snapshots expire then anyway).
