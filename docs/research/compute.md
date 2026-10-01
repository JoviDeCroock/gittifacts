# Cloudflare compute primitives: CI, Workflows, Containers, cf config, Versions (verified 2026-10-01)

All facts below were checked against primary sources on 2026-10-01. Read-only: no resources were created. Source tags:

- **[CI]** `@cloudflare/ci@0.2.0` npm tarball (`src/…:line`). **[CIR]** github.com/cloudflare/ci @ `fbbc290` (2026-09-14) `examples/…`
- **[T]** `@cloudflare/workers-types@5.20261001.1` `index.d.ts:line` (**[Tx]** = `experimental/index.d.ts`)
- **[W]** `wrangler@4.145.0` `config-schema.json:line` / `wrangler-dist/cli.js:line`
- **[VP]** `@cloudflare/vitest-plugin@1.3.4` `types/cloudflare-test.d.ts:line` (same API in `@cloudflare/vitest-pool-workers@0.22.0`)
- **[CFG]** `cf@1.0.0-beta.10` → `cf/config` re-exports `@cloudflare/config@0.22.0` `dist/public-DFY8wDEh.d.mts:line`
- **[SB]** `@cloudflare/sandbox@1.0.0` README (published 2026-09-30)
- **[D:x]** `https://developers.cloudflare.com/x/index.md`. **[CL:slug]** `https://developers.cloudflare.com/changelog/post/slug/`. **[B3]** blog.cloudflare.com/ci-workflows

## 0. TL;DR

1. **`@cloudflare/ci` works today without an allowlist, but it doesn't fit our constraints.** No code path checks account flags or beta access [CI, grep]. Its hard dependencies are Artifacts (open beta since 2026-10-01, Workers Paid [CL:2026-10-01-artifacts-open-beta]), Workflows (GA), Containers (GA), and R2. It is built on the **legacy `@cloudflare/sandbox@0.12.1` `Sandbox` class**, pinned exactly in [CI package.json:55], and on a `default`-policy container (`docker.io/cloudflare/sandbox:0.12.1`) [CIR examples/cloudflare-artifacts/Dockerfile]. Sandbox 0.x gets fixes only until 2026-12-31 [D:sandbox/sdk/migrate]. Its only source provider is Cloudflare Artifacts. **Recommendation:** copy the *pattern* (Workflow step per runner, chaining runners through snapshots, R2 cache pointer keyed on input blob hashes) and reimplement the runner on `ctx.container`.
2. **`ctx.container` handles exec directly, so the image doesn't need an HTTP server.** `exec(cmd: string[], opts) → ExecProcess`, and `output()` returns `{ stdout: ArrayBuffer, stderr: ArrayBuffer, exitCode }` [T:3960-3989, 4005]. `start()` is synchronous (`void`), so you need your own readiness check. `snapshotContainer()` works only with `scheduling_policy: "durable_object"`, which is **public beta** [D:containers/configuration/scheduling-policy].
3. **The `durable_object` policy rejects `image`, `instance_type` and `max_instances` in config.** You declare `images: { name: { dockerfile } }`, then pick the image and instance at runtime in `start({ image, instance, enableInternet })` [W cli.js:22294].
4. **Workflows** adds restart-from-step (`restart({ from: { name } })`), rollback handlers, `subscribe()`, `deleteBatch`, `exports`-declared Workflows via `ctx.exports`, cron `schedules`, and **`triggers.events`** (Artifacts events → Workflow) [T:18146-18490] [W config-schema.json:4093].
5. **Use `wrangler.jsonc` for now, not `cloudflare.config.ts`.** The `cf` config can't express `triggers.events` (Artifacts push → Workflow), D1 `migrations_dir`, or per-Preview containers, and the docs say `cf previews deploy` doesn't support DO-managed Containers. `cf migrate` doesn't convert Workflows or Containers, and the format is beta and "can change". Revisit when it stabilizes.
6. **Version URLs (formerly "preview URLs") aren't generated for Workers that define any Durable Object** [D:workers/versions-and-deployments/version-urls]. Gradual deployments still work, by DO-to-version assignment. For PR testing, use **Worker Previews** (`wrangler preview`).

---

## 1. `@cloudflare/ci@0.2.0`

**Package facts.** Versions 0.1.0 (2026-08-03) and 0.2.0 (2026-09-14). It ships **TypeScript source only** (`exports` → `./src/*.ts`), for Workers bundlers. Importing `@cloudflare/ci/worker` requires `nodejs_compat` [CI README:13-17]. Dependencies are `@cloudflare/sandbox: "0.12.1"` (exact pin) and `zod ^4.4.3` [CI package.json:54-57]. Entry points [CI src/index.ts, src/worker.ts, src/worker-source-control.ts]:

```ts
// '@cloudflare/ci'
export { CIWorkflow, cloudflareArtifacts, isCiRunnerFailure };
export type { CiContext, CiParams, CiRunnerFailureDiagnostics, CiRunnerResult, CiWorkflowPayload,
  CloudflareArtifacts, CloudflareArtifactsPushEvent, RunnerConfig };
// '@cloudflare/ci/worker'
export { CiSandbox /* = class extends Sandbox<Bindings> from @cloudflare/sandbox 0.12.1 */, restartCiRun, startCiRun };
export type { CiBindings, DirectoryBackup, RunnerOptions, CreatePullRequestResult, SourceControlCheckout, … };
// '@cloudflare/ci/worker/source-control'
export { cloudflareArtifacts }; export type { SourceControlAdapter };
```

### 1.1 Declaring a pipeline [CI src/pipeline/types.ts:153-202] [CIR examples/cloudflare-artifacts/cloudflare.ci.ts]

```ts
type RunnerOptions = {
  name: string;               // becomes the Workflow step name: must be deterministic and unique
  command: string;            // shell string; runs as `(${command}) > /tmp/ci-step.out 2> /tmp/ci-step.err` in /workspace
  cwd?: string;               // must stay inside /workspace
  env?: Record<string,string>;
  cache?: { inputs: string[] };           // globs over git blob SHAs; a hit skips the command
  config?: { retries?: {limit; delay:number; backoff?}; timeout?: number /*ms*/;
             commandTimeoutMs?: number; snapshotRetentionSeconds?: number };
  cloudflareCredentials?: boolean | { accountId: string }; // injects CLOUDFLARE_API_TOKEN (=env.CF_TOKEN) [+ACCOUNT_ID]
  sourceControlCredentials?: boolean;     // Artifacts: ARTIFACTS_REMOTE + ARTIFACTS_TOKEN (1h read token)
  secrets?: string[];                     // names of env secrets copied into the command env
};
type CiContext      = { runner(o: RunnerOptions): Promise<CiRunnerResult> };   // independent: no inherited snapshot
type CiRunnerResult = CiRunStepOutput & { runner(o: RunnerOptions): Promise<CiRunnerResult> }; // chained: restores this snapshot
type CiRunStepOutput = { exitCode: number; logs: { stdout: string|ReadableStream; stderr: string|ReadableStream };
                         snapshot: DirectoryBackup /* {id, dir, localBucket?} */; cachePointer?: { key; createdAt; sizeBytes } };

export class CI extends CIWorkflow<CloudflareArtifacts, Bindings> {
  protected async pipeline(event, step, ci: CiContext) {
    const deps = await ci.runner({ name: 'install', command: 'npm ci', cache: { inputs: ['package.json','package-lock.json'] } });
    await Promise.all([                       // parallel runners: each is its own step.do + its own sandbox
      deps.runner({ name: 'lint', command: 'npm run lint' }),
      deps.runner({ name: 'test', command: 'npm run test' }),
    ]);
    await deps.runner({ name: 'deploy', command: 'npm exec wrangler deploy', cloudflareCredentials: { accountId: this.env.CLOUDFLARE_DEPLOY_ACCOUNT_ID } });
  }
}
```

- **Mechanics** [CI src/pipeline/ci-workflow.ts:141-178]: each runner is one `step.do(name, {retries, timeout}, …)`. Defaults are retries `{limit:2, delay:30_000, backoff:'linear'}` and timeout 12 min. The command timeout defaults to the step timeout minus 10 s [ci-workflow.ts:29-34, 186-210]. Each step creates a new sandbox named `<slug(label)>-<uuid>`, checks out the commit with `git fetch --depth=1` over Artifacts smart HTTP using a Bearer token, optionally restores the parent snapshot, runs the command, then calls `sandbox.createBackup({dir:'/workspace', multipart:true, ttl})` to R2. The default backup TTL is 30 days. The sandbox is destroyed afterwards [CI src/ci/runners/sandbox.ts:38-142; src/ci/capabilities.ts:29].
- **Cache** [CI src/ci/cache.ts]: the key is a hash of the repo scope (`provider:owner/repo:ref`), label, command, cwd, env, and the matched blob SHAs. A pointer is stored as `cache/<key>.json` in `BACKUP_BUCKET`. Blob SHAs come from walking the tree with `ARTIFACTS.get(repo).readCommit/readTree`. These methods are now typed in [T:12618, 12627], so the CI source comment calling them untyped is out of date.
- **Failures** [CI src/pipeline/runner-group.ts, failures.ts]: a nonzero exit throws inside the step, so Workflows retries it. When retries run out, the error is a `CiRunnerFailure { runner, snapshot?, output (last 20 000 chars), diagnostics: { failures[], runners[] } }`. The group waits for all active parallel runners, then rethrows the earliest-started failure. Check for it with `isCiRunnerFailure(e)`.
- **HealingAgent is not part of the package.** It lives in `examples/self-healing/src/healing/healer.ts` as `class HealingAgent extends Think<Bindings>` (`@cloudflare/think`, `agents`, `ai`), with `maxSteps = 25`. The pipeline catches `CiRunnerFailure` and calls `step.do('heal', {retries:{limit:0,delay:0}, timeout:'5 hours'}, () => getAgentByName(env.HEALER, instanceId).heal({failure, prompt}))`. The agent pushes a verified fix to `ci-autofix/<run-id>` [CIR examples/self-healing/cloudflare.ci.ts:14-66, README:61].
- **Restart-from-step isn't exposed by the package.** `restartCiRun(env, source)` → `CI_WORKFLOW.get(runId).restart()` with no `from`, so it restarts from the beginning [CI src/ci/dispatch.ts:25-29]. Cached step outputs carry snapshot handles, so calling `instance.restart({ from: { name: 'test' } })` yourself should work as long as backups haven't expired (§2). The blog advertises this capability [B3].

### 1.2 Required bindings and config [CI src/env.ts:11-31] [CIR examples/*/wrangler.jsonc]

```ts
type Bindings = { CF_TOKEN: string; R2_ACCESS_KEY_ID: string; R2_SECRET_ACCESS_KEY: string;   // secrets
  ARTIFACTS: Artifacts; BACKUP_BUCKET: R2Bucket; BACKUP_BUCKET_NAME: string; CLOUDFLARE_ACCOUNT_ID: string; // must be 32-hex
  SANDBOX: DurableObjectNamespace<CiSandbox>; CI_WORKFLOW: Workflow<CiParams<CloudflareArtifacts>> };
```

```jsonc
{ "compatibility_flags": ["nodejs_compat"],
  "artifacts": [{ "binding": "ARTIFACTS", "namespace": "ns" }],
  "containers": [{ "class_name": "CiSandbox", "image": "./Dockerfile", "max_instances": 10, "instance_type": "standard-4" }], // default policy
  "durable_objects": { "bindings": [{ "name": "SANDBOX", "class_name": "CiSandbox" }] },
  "exports": { "CiSandbox": { "type": "durable-object", "storage": "sqlite" } },
  "workflows": [{ "name": "ci", "binding": "CI_WORKFLOW", "class_name": "CI" }],
  "triggers": { "events": [{ "type": "cf.artifacts.repo.pushed", "filter": { "namespace": "ns", "repo_name": "r" },
                             "targets": [{ "type": "workflow", "workflow_name": "ci" }] }] },
  "r2_buckets": [{ "binding": "BACKUP_BUCKET", "bucket_name": "ci-backups" }] }
// Dockerfile: FROM docker.io/cloudflare/sandbox:0.12.1@sha256:ea9b35e6…
```

### 1.3 Invocation and results

- **Push trigger:** `triggers.events` sends the raw `CloudflareArtifactsPushEvent` as the Workflow payload. `CIWorkflow.run()` normalizes it. Deleted refs, non-branch/tag refs, and unmatched repos return `{conclusion:'success'}` without doing anything [ci-workflow.ts:77-110; src/artifacts/events.ts:53-84].
- **Manual trigger:** `startCiRun(env, params)` calls `env.CI_WORKFLOW.createBatch([{ id: 'ci-<provider≤12>-<repo≤16>-<sha256(provider,owner,repo,sha)>', params }])`. The id is deterministic per commit [CI src/ci/dispatch.ts:15-22, run-id.ts].
- **Where results show up:** Workflow step outputs and status (Workflows dashboard), `observability.logs`, and the thrown `CiRunnerFailure`. `logs` are raw and **not redacted**; only notification previews and errors are [CI README:44-47]. The Artifacts provider implements no step notifications (base class returns `null`) [CI src/source-control.ts:178-182]. Open issues: #15 (undisposed RPC results, and live log streams returned from steps), #8 (credentials can leak into failure output and step state), #10.
- **Non-Artifacts sources:** override `static getProvider(): SourceControlAdapter`. The abstract `SourceControlProvider` class isn't exported, so you have to implement it structurally. `CiProvider` is typed only as `CloudflareArtifacts` [CI src/pipeline/types.ts:43].

---

## 2. Workflows (GA): `cloudflare:workers` API

```ts
// [T:16423-16625]  module "cloudflare:workers"
type WorkflowSleepDuration = `${number} ${'second'|'minute'|'hour'|'day'|'week'|'month'|'year'}${'s'|''}` | number;
type WorkflowStepConfig = { retries?: { limit: number; delay: WorkflowDelayDuration | number | WorkflowDelayFunction; backoff?: 'constant'|'linear'|'exponential' };
                            timeout?: WorkflowTimeoutDuration | number; sensitive?: 'output' };
type WorkflowDelayFunction = (i: { ctx: WorkflowStepContext; error: Error }) => WorkflowDelayDuration | Promise<…>; // dynamic retry delay (2026-07-09)
type WorkflowEvent<T> = { payload: Readonly<T>; timestamp: Date; instanceId: string; workflowName: string; schedule?: { cron: string; scheduledTime: number } };
type WorkflowStepContext = { step: { name: string; count: number }; attempt: number; config: {…} };
abstract class WorkflowStep {
  do<T>(name, cb: (ctx) => Promise<T>, rollback?: { rollback: (c: { ctx; error; output: T|undefined }) => Promise<void>; rollbackConfig?: {retries?; timeout?} }): Promise<T>;
  do<T>(name, config: WorkflowStepConfig, cb, rollback?): Promise<T>;   // T may be ReadableStream<Uint8Array> (>1 MiB outputs)
  sleep(name: string, d: WorkflowSleepDuration): Promise<void>;          // max 365 days
  sleepUntil(name: string, t: Date | number): Promise<void>;
  waitForEvent<T>(name: string, o: { type: string /*≤100 chars*/; timeout?: WorkflowTimeoutDuration|number }): Promise<{ payload: T; timestamp: Date; type: string }>; // default timeout 24 h
}
abstract class WorkflowEntrypoint<Env, T> { protected ctx: ExecutionContext; protected env: Env; run(event, step): Promise<unknown> }
// module "cloudflare:workflows" [T:18136-18145]
class NonRetryableError extends Error {}
```

```ts
// [T:18146-18490] binding: env.WF or ctx.exports.MyWorkflow
declare abstract class Workflow<P> {
  get(id: string): Promise<WorkflowInstance>;
  create(o?: { id?: string /*≤100, unique; throws if it exists*/; params?: P; retention?: { successRetention?; errorRetention? }; locationHint?: 'wnam'|'enam'|'weur'|… }): Promise<WorkflowInstance>;
  createBatch(o: WorkflowInstanceCreateOptions<P>[]): Promise<WorkflowInstance[]>;   // ≤100 per call / 1 MiB
  deleteBatch(ids: string[]): Promise<{ deleted: {id}[]; errors: {id; code; message}[] }>; // ≤100
}
declare abstract class WorkflowInstance {
  id: string; pause(); resume(); delete();
  terminate(o?: { rollback?: boolean }): Promise<void>;
  restart(o?: { from?: { name: string; count?: number /*1-indexed*/; type?: 'do'|'sleep'|'waitForEvent' } }): Promise<void>; // keeps cached results before `from`
  status(): Promise<{ status: 'queued'|'running'|'paused'|'errored'|'terminated'|'complete'|'waiting'|'waitingForPause'|'rollingBack'|'unknown'; error?: {name; message}; output?: unknown }>;
  sendEvent(e: { type: string; payload: unknown }): Promise<void>;
  subscribe(o?: { cursor?: number; filter?: WorkflowInstanceEventType[] }): Promise<WorkflowInstanceSubscription /* Disposable; next() */>;
}  // event types: workflow_* , step_started|completed|errored, attempt_*, sleep_*, wait_started|completed|timed_out, rollback_* [T:18280-18436]
```

- **Defaults:** `retries {limit:5, delay:10000, backoff:'exponential'}` and `timeout '10 minutes'` [D:workflows/build/sleeping-and-retrying]. On Paid, step CPU is 30 s by default (configurable to 5 min) and wall time is unlimited. Other Paid limits: 10 000 steps (configurable to 25 000), 1 MiB non-stream step result or event payload, 1 GB state per instance, 50 000 concurrent instances, creation at 300/s per account and 100/s per workflow, 30-day retention. The retention default for new Workflows is 7 days [D:workflows/reference/limits] [CL:2026-09-10-paid-retention-default].
- **Config.** You can use a `workflows[]` binding `{ name, binding, class_name, script_name?, limits?{steps}, concurrency?{limit}, schedules?, default_retention? }`. Alternatively, use the new **`exports`** entry `{ "MyWorkflow": { "type": "workflow", "name": "my-wf", limits?, concurrency?, schedules?, default_retention? } }` (wrangler ≥4.139), which you call through **`ctx.exports.MyWorkflow.create()`** (≥4.142) [W config-schema.json:4009] [CL:2026-09-24-workflow-exports] [CL:2026-09-27-workflow-ctx-exports].
- **Triggers that start an instance:**
  - `schedules` (cron, ≤100 per account; `event.schedule` is set) [D:workflows/build/trigger-workflows].
  - **`triggers.events`**, which is Artifacts only. Types are `cf.artifacts.repo.{created,deleted,forked,imported,pushed,cloned,fetched,token.created,token.revoked}`. `filter` takes `namespace` and `repo_name` only. `targets` must be `[{type:"workflow", workflow_name}]`, and the target **must be a Workflow owned by this Worker** [W config-schema.json:4093-4150; cli.js:23582-23611, 160713-160725].
  - Everything else uses Queues event subscriptions plus a consumer that calls `create`.
  - Workflows publish their own `cf.workflows.workflow.instance.*` events [D:workflows/reference/event-subscriptions].
- **Testing** [VP:312, 672]. `@cloudflare/vitest-pool-workers` is superseded by **`@cloudflare/vitest-plugin`** [D:workers/testing/vitest-integration]. Note that introspection still **needs a binding**: it doesn't work through `ctx.exports`, so add a test-only binding [CL:2026-09-27-workflow-ctx-exports].

```ts
import { introspectWorkflowInstance, introspectWorkflow } from 'cloudflare:test';
await using inst = await introspectWorkflowInstance(env.WF, 'id-1');
await inst.modify(async m => {
  await m.disableSleeps(); await m.disableRetryDelays([{ name: 'x' }]);
  await m.mockStepResult({ name: 'fetch', index: 1 }, { ok: true });
  await m.mockStepError({ name: 'build' }, new Error('boom'), 2);
  m.forceStepTimeout({ name: 'slow' }); await m.mockEvent({ type: 'approved', payload: {} });
  await m.forceEventTimeout({ name: 'wait' });
});
await env.WF.create({ id: 'id-1' });
await inst.waitForStepResult({ name: 'fetch' }); await inst.waitForStatus('complete');
await inst.getOutput(); /* or */ await inst.getError();
await using all = await introspectWorkflow(env.WF); await all.modifyAll(async m => …); await all.get();
```

---

## 3. Containers via `ctx.container` (`scheduling_policy: "durable_object"`, public beta since 2026-09-30)

### 3.1 Wrangler config [D:containers/configuration/scheduling-policy] [W config-schema.json:6334-6600; cli.js:22215-22300]

```jsonc
{
  "containers": [{
    "class_name": "Runner",                   // or "name", referenced from exports.<Class>.container
    "scheduling_policy": "durable_object",    // immutable per app; enum: default | durable_object | moon | regional
    "images": {                               // → ctx.container.images.<key>; ≤100 images; key 1-128 chars
      "base": { "dockerfile": "./container/Dockerfile", "build_context": "./container", "build_vars": {} },
      "pinned": { "image": "registry.cloudflare.com/<ACCOUNT_ID>/<repo>@sha256:<digest>" }  // CF registry only, digest-pinned
    },
    "observability": { "logs": { "enabled": true } }, "ssh": { "enabled": true }
  }],
  "durable_objects": { "bindings": [{ "name": "RUNNER", "class_name": "Runner" }] },
  "exports": { "Runner": { "type": "durable-object", "storage": "sqlite" } }   // sqlite required; don't mix with "migrations"
}
```

- For DO-managed apps, wrangler **rejects** every field except `name, class_name, scheduling_policy, images, observability, ssh, authorized_keys` and a restricted `unsafe` [W cli.js:22294]. That means **no `image`, `instance_type`, `max_instances`, `rollout_*` or `constraints`**. Instances count against account limits: 1 500 vCPU, 6 TiB RAM, 30 TB disk [D:containers/platform/limits].
- `images` can be omitted. You can then start the managed `"cloudflare/debian-trixie"` image (Node 24.20.0, Debian Trixie slim), which is only available with this policy. If you omit `images`, run `wrangler deploy` to provision the app before any `wrangler versions upload` [W config-schema.json, ContainerApp.images description].
- Deploying a new image map doesn't restart running containers. Your code decides when to `destroy()` and re-`start()` [D:containers/guides/image-management]. During a gradual deploy, `images` reflects the version that's running that DO.
- Local dev needs Docker and wrangler ≥4.136, or ≥4.141 for `debian-trixie` [D:containers/guides/local-dev]. Deployed hostnames are 64 characters and don't resolve. Every deployed process has root capabilities regardless of `user`.

### 3.2 Runtime API [T:695-712, 3960-4066] [D:containers/api/durable-object-container]

```ts
interface DurableObjectState { container?: Container; /* undefined if no container is configured */ … }
interface Container {
  get running(): boolean;                          // true ≠ ready
  get images(): Record<string, string>;            // durable_object only
  start(o?: ContainerStartupOptions): void;        // returns once options validate; errors surface via monitor(); throws if already running
  monitor(): Promise<void>;                        // resolves on exit 0 / destroy(); rejects with Error{exitCode}; holds DO in memory ≤15 min
  destroy(reason?: any): Promise<void>;
  signal(signo: number): void;                     // e.g. 15 SIGTERM, 9 SIGKILL to the main process
  getTcpPort(port: number): Fetcher;               // .fetch('http://container/…') or .connect(); "Container is not listening to port N" until ready
  setInactivityTimeout(ms: number | bigint): Promise<void>; // >0, ≤6 h; reset after each DO restart (set in constructor if running)
  exec(cmd: string[], o?: ContainerExecOptions): Promise<ExecProcess>;  // GA 2026-06-18; waits for a container that is still starting; throws if stopped
  snapshotContainer(o?: { name?: string }): Promise<{ id: string; size: number; name?: string }>; // durable_object only; pass {} (omitting → TypeError)
  inspect(): Promise<{ image: string; labels: Record<string,string> } | null>;
  interceptOutboundHttp(addr: string, b: Fetcher): Promise<void>; interceptAllOutboundHttp(b: Fetcher): Promise<void>;
  interceptOutboundHttps(addr: string, b: Fetcher): Promise<void>;  // ≤128 intercept entries per container
}
type ContainerStartupOptions = {
  enableInternet: boolean; entrypoint?: string[]; env?: Record<string,string>; labels?: Record<string,string> /*≤10*/;
  instance?: 'lite'|'standard-1'|'standard-2'|'standard-3'|'standard-4' | { vcpu: number; memoryMib: number; diskMb: number }; // default 'lite'; no 'basic'
  directorySnapshots?: ({ snapshot: ContainerDirectorySnapshot; mountPoint?: string } | { mountPoint: string })[]; // typed, undocumented
} & ({ image: string; containerSnapshot?: never } | { image?: never; containerSnapshot?: { id: string } });
interface ContainerExecOptions { cwd?: string; env?: Record<string,string>; user?: `${uid}:${gid}`; signal?: AbortSignal;
  pty?: boolean | { cols?: number; rows?: number }; stdin?: ReadableStream | 'pipe'; stdout?: 'pipe'|'ignore'; stderr?: 'pipe'|'ignore'|'combined' }
interface ExecProcess { stdin: WritableStream|null; stdout: ReadableStream|null; stderr: ReadableStream|null; pid: number; isPty: boolean;
  exitCode: Promise<number>; output(): Promise<{ stdout: ArrayBuffer; stderr: ArrayBuffer; exitCode: number }>; kill(sig?: number): void; resize(c, r): void }
// experimental-only [Tx:4157-4161, 4197]: interceptOutboundTcp, snapshotDirectory({dir,name?}), setLabels, start({hardTimeout})
```

**How exec behaves.** Nonzero exits *resolve*, they don't reject. There's **no shell**, so use `['sh','-c', cmd]`. The `exec` env does **not** inherit `start({env})` or the image env, except `PATH`. There's **no built-in timeout**: use `kill()` or coreutils `timeout --kill-after`. `kill`/`signal` reach only the direct child. Calling `kill()` after the process exits raises an uncaught internal error, so use your own `AbortController` and stop it once `exitCode` settles. `output()` buffers in DO memory, and that counts toward the DO memory limit, so stream `stdout`/`stderr` for large logs. Cancelling the caller doesn't stop the process [D:containers/api/durable-object-container#exec] [D:containers/guides/execute-commands].

**Snapshots.** These are root-filesystem only: no memory, processes or mounts. They're immutable, up to 20 GB, and have a 30-day TTL that refreshes on restore. You can't list them, so store the handle in DO storage. A snapshot is tied to its image, can be restored from another DO, and runs the entrypoint again on start [D:containers/guides/snapshots] [D:containers/platform/limits].

**CI runner sketch, using only `ctx.container`:**

```ts
export class Runner extends DurableObject<Env> {
  async run(job: { cmd: string; snapshot?: { id: string }; env: Record<string,string> }) {
    const c = this.ctx.container!;
    if (!c.running) c.start(job.snapshot ? { containerSnapshot: job.snapshot, enableInternet: true, instance: 'standard-2' }
                                         : { image: c.images.base, enableInternet: true, instance: 'standard-2', entrypoint: ['sleep','infinity'] });
    const p = await c.exec(['sh','-c', `timeout --kill-after=10 600 sh -c ${q(job.cmd)}`], { cwd: '/workspace', env: job.env, stderr: 'combined' });
    const [log, exitCode] = await Promise.all([streamToR2(p.stdout!), p.exitCode]);   // streamToR2/q = your helpers; don't buffer large output
    const snap = exitCode === 0 ? await c.snapshotContainer({ name: 'step' }) : undefined;
    await c.destroy(); return { exitCode, logKey: log, snapshot: snap && { id: snap.id } };
  }
}
// The Workflow calls it as: step.do('test', { timeout: '30 minutes' }, () => env.RUNNER.getByName(`${runId}:test`).run({...}))
```

**Legacy APIs.** `@cloudflare/containers` `Container` class (0.3.7) **does not support** the `durable_object` policy, but has no end-of-life date [D:containers/api/container-class]. `@cloudflare/sandbox` **1.0.0 (2026-09-30) dropped the `Sandbox` class**: it's now `Files`, `S3Mount` and `DirectoryBackup` helpers that take a `ctx.container` [SB]. Sandbox **0.x** gets bug/security fixes until 2026-12-31, keeps running after that, and moving a class to `durable_object` can't be undone [D:sandbox/sdk/migrate].

---

## 4. `cf` CLI + `cloudflare.config.ts` vs `wrangler.jsonc`

**Format.** `import { defineConfig, defineWorker, defineContainer, bindings, triggers, exports } from "cf/config"`. These are re-exported from `@cloudflare/config@0.22.0` ("not yet stable… APIs may change") [CFG:1-1901]. Install with `npm i -D cf`. Types are generated by `cf workers types` into `.cloudflare/types/index.d.ts`.

```ts
import { bindings, defineConfig, defineContainer, exports, triggers } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };
const runner = defineContainer({ name: "runner", schedulingPolicy: "durable-object",      // NB hyphen (wrangler: durable_object)
  images: { base: { dockerfile: "./container/Dockerfile" } } });                          // or { reference: "registry…@sha256:…" }
export default defineConfig(({ isPreview, mode }) => ({ accountId: "…", containers: [runner],
  worker: { name: "api", compatibilityDate: "2026-10-01", compatibilityFlags: ["nodejs_compat"], entrypoint,
    env: { DB: bindings.d1({ id: "…" }), KV: bindings.kv({ id: "…" }), BUCKET: bindings.r2({ name: "…" }),
      Q: bindings.queue({ name: "jobs" }), AE: bindings.analyticsEngineDataset({ name: "…" }), AI: bindings.ai(),
      BROWSER: bindings.browser(), FLAGS: bindings.flagship({ id: "…" }), REPOS: bindings.artifacts({ namespace: "…" }),
      ASSETS: bindings.assets(), TOKEN: bindings.secret(), VER: bindings.versionMetadata(),
      RUNNER: bindings.durableObject({ worker: "api", exportName: "Runner" }),
      WF: bindings.workflow({ name: "ci", worker: "api", exportName: "CiWorkflow" }) },
    triggers: [triggers.queue({ name: "jobs", maxBatchSize: 10 }), triggers.scheduled({ schedule: "0 * * * *" }), triggers.fetch({ pattern: "x.com/*", zone: "x.com" })],
    exports: { Runner: exports.durableObject({ storage: "sqlite", container: runner }),
               CiWorkflow: exports.workflow({ name: "ci", schedules: "0 3 * * *" }) } } }));
```

| Need | `wrangler.jsonc` (4.145) | `cloudflare.config.ts` (cf beta.10) |
|---|---|---|
| DO, Workflows, D1, R2, KV, Queue producer and consumer, AE, Browser, AI, Flagship, Artifacts, secrets, assets, version metadata | yes | yes: `bindings.*` [CFG:1724-1900], consumer through `triggers.queue` |
| Containers with the `durable_object` policy | yes | yes (`schedulingPolicy:"durable-object"`, `images`) [CFG:797-811] |
| **`triggers.events` (Artifacts push → Workflow)** | **yes** [W:4093] | **no**: the `Trigger` union is fetch, queue, scheduled, email, connect [CFG:627] |
| D1 migrations dir | `migrations_dir` | only CLI flags: `cf d1 migrations apply <DB_ID> --dir` (remote by default) [D:cf/wrangler/reference] |
| Previews | `previews{}` block, `wrangler preview` | `ctx.isPreview` branch, `cf previews deploy`; **no DO-managed Containers** [D:cf/projects] |
| Tail logs, single `secret put` | yes | no, use `npx wrangler` [D:cf/wrangler] |
| `cf migrate` | n/a | doesn't convert Workflows, Containers or DO migrations (they become manual TODOs) [D:cf/wrangler/migrate] |
| Deploy, version, gradual | `deploy`, `versions upload/deploy` | `cf deploy --tag --message`, `cf workers versions create [--preview-alias]`, `cf workers deployments create --strategy percentage --versions '[…]'` |

**Recommendation.** Use **`wrangler.jsonc` with `"$schema": "node_modules/wrangler/config-schema.json"`**, pin wrangler ≥4.145.0, and use `exports` instead of `migrations`. Use `cf` only for API and resource commands (`cf cli search`, `cf schema`), which work in an unmigrated project. **Don't run `cf dev`, `cf build` or `cf deploy` in a Wrangler project**: autoconfig rewrites `package.json` and other files [D:cf/wrangler]. Re-evaluate once `cf` config supports `triggers.events` and DO-managed containers in Previews.

---

## 5. Versions, gradual deployments, Version URLs, Previews

```sh
wrangler versions upload --tag "$CHANGE_ID" --message "change $CHANGE_ID: $TITLE" [--preview-alias pr-12] [--secrets-file f.json] [--dry-run]
wrangler versions deploy <vid1>@10% <vid2>@90% --message "…" -y          # or: --version-tag "$CHANGE_ID"@10 … ; --version-id/--percentage
wrangler versions deploy … --durable-objects-code-update-mode "deferred 30s"   # or immediate
wrangler versions list|view ; wrangler rollback ; wrangler preview [--name pr-12 --tag --message --json] ; wrangler preview delete --name pr-12
```

```http
POST /accounts/{account_id}/workers/scripts/{script}/versions        (multipart: metadata JSON + modules)   [W cli.js:175901, 176340-176362]
  metadata.annotations = { "workers/message": "...", "workers/tag": "...", "workers/alias": "pr-12" }
POST /accounts/{account_id}/workers/scripts/{script}/deployments[?force=true]                               [W cli.js:163199-163216]
  { "strategy": "percentage",
    "versions": [{ "version_id": "<uuid>", "percentage": 90 }, { "version_id": "<uuid>", "percentage": 10 }],   // must total 100
    "annotations": { "workers/message": "..." },
    "code_update_strategy": { "mode": "immediate" | "deferred", "max_delay": 300 } }   // [W config-schema.json:3638]
GET  /accounts/{account_id}/workers/workers/{worker_id}/versions/{version_id}            (cf schema workers versions get)
POST /accounts/{account_id}/workers/workers/{worker}/previews/{preview}/deployments     (wrangler preview) [W cli.js:176826]
  annotations: workers/commit_sha, workers/pull_request_{number,title,url}, workers/repository_url, workers/message, workers/tag  [W cli.js:177745-177755]
```

- **Linking a version to a Change id:** use `--tag <changeId>` and read it at runtime with the `version_metadata` binding → `{ id, tag, timestamp }` [T:17994]. You can deploy by tag with `--version-tag`. Logpush `ScriptVersion {id, message, tag}` [D:workers/versions-and-deployments/gradual-deployments]. Only the **last 100 uploaded versions** can be deployed.
- **Version URL format:** `<version-prefix>-<worker>.<subdomain>.workers.dev`, or with an alias, `<alias>-<worker>.<subdomain>.workers.dev`. Enable it with `preview_urls: true`; if omitted it follows `workers_dev`. Aliases are only set at upload, must be ≤63 characters combined, and only the last 1000 are kept. **Version URLs aren't generated for Workers that implement a Durable Object (including Containers) or for WfP user Workers**, and Version URL traffic doesn't appear in Workers Logs, tail or Logpush [D:workers/versions-and-deployments/version-urls].
- **Gradual deployments with DOs:** each DO instance is pinned to one version per deployment, and resets once when it's reassigned. You **can't upload versions that change a DO class's lifecycle** (`exports`/`migrations`); those need `wrangler deploy` [D:…/gradual-deployments/with-durable-objects].
- **Worker Previews** (wrangler ≥4.135) are the recommended way to test PRs:
  - Preview URL: `<preview>-<worker>.<sub>.workers.dev`.
  - Deployment URL: `<deployment-id>-<worker>.<sub>.workers.dev`.
  - Each Preview gets its own DO namespace and a container app named `<worker>_<preview>_<Class>`, which needs a `previews.containers` entry.
  - **Workflows aren't per-Preview**: bindings hit an existing Workflow. Queue consumers, crons and routes stay in production.
  - Limits are 500 Previews per Worker (Paid) and 100 deployments per Preview [D:workers/previews] [D:workers/previews/resources].

---

## 6. Discrepancies vs prompt

1. **"`HealingAgent` in `@cloudflare/ci`":** it isn't in the package. It's application code in `examples/self-healing` [CIR].
2. **"restart-from-step" in CI:** the package's `restartCiRun` restarts from the beginning. Step-level restart is the generic Workflows `restart({from})`.
3. **"Usable without private-beta allowlisting?":** the blog (2026-08-04) said "Request to join the Artifacts private beta" [B3]. As of today, Artifacts is in **open beta on Workers Paid** (billing from 2026-10-14). There are no gates in the code.
4. **"Containers config shape: image, class_name, instance_type, max_instances, scheduling_policy":** with `durable_object`, `image`, `instance_type` and `max_instances` are **rejected**. Use `images{}` plus runtime `start({image, instance})`.
5. **"Legacy `Container`/`Sandbox` classes deprecated after 2026-12-31":** only **Sandbox SDK 0.x** has that date, and it means end of fixes, not shutdown. The `Container` class has no stated end-of-life; it just can't use the `durable_object` policy. `@cloudflare/sandbox@latest` (1.0.0) no longer has a `Sandbox` class.
6. **"`ctx.container` rebuilt for Birthday Week":** the `durable_object` policy and snapshots shipped 2026-09-30 as **public beta**. `exec()` has been GA since 2026-06-18.
7. **"Workers Builds Preview URLs":** these are now called **Version URLs**. "Previews" is a separate product (Worker Previews).
8. **Docs vs tooling for `triggers.events`:** the docs and changelog show `filter.repoName` and `target: { scriptName, workflowName }`. wrangler 4.145 **only accepts** `filter.repo_name` and `targets: [{ type: "workflow", workflow_name }]` (strict validation) [W cli.js:23582-23611]. Follow the wrangler schema.
9. **`@cloudflare/vitest-pool-workers`** is superseded by `@cloudflare/vitest-plugin` (same `introspectWorkflow*` API).
10. **`cf` config `schedulingPolicy` is `"durable-object"` (hyphen)**, while wrangler uses `"durable_object"`. Image references are `{reference}` in cf and `{image}` in wrangler.

## 7. Open questions

- What does `createBatch` do with an id that already exists? The types say it throws [T:18163]. `startCiRun` assumes it returns no instance and `null` is returned [CI dispatch.ts:11-21]. Test it before relying on idempotent per-commit ids.
- How does `restart({ from: { name } })` order steps that ran in parallel (`Promise.all`)? What does "steps before it" mean for siblings?
- Do Worker Previews (via `wrangler preview`, not `cf`) support `durable_object`-policy containers? The cf docs say cf previews don't [D:cf/projects]. The Workers Previews docs only show `default`-policy examples.
- With no Version URLs for DO Workers, how should a per-Change URL work if the API Worker defines DOs? Options are Previews per Change (limit 500), splitting DOs into a separate Worker, or version overrides (`Cloudflare-Workers-Version-Overrides` header) [D:workers/versions-and-deployments/version-overrides].
- What are the cold-start and snapshot-restore latency and the snapshot cost for `durable_object` containers? The Sandbox 1.0 docs claim a median of <600 ms from `start()` to first exec on a prepared image [D:sandbox/sdk/migrate]. Snapshot pricing isn't on the limits page.
- `snapshotDirectory()` and `start({directorySnapshots, hardTimeout})` are typed (partly experimental-only) but undocumented. Avoid them until they're documented.
- Does Workflows step CPU (30 s default) count while awaiting a DO RPC that's running a long `exec`? Wall time is unlimited, so it's presumably fine, but confirm under load.
