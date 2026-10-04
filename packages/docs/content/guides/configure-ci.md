---
title: Configure CI (.platform/ci.ts)
nav: Configure CI
description: Edit the pipeline - steps, parallelism, caching, artifacts, environment, test targets - and ship the edit through a Change.
order: 45
audience: both
group: Set up a repo
---

# Configure CI (`.platform/ci.ts`)

**You'll have:** a `.platform/ci.ts` pipeline with cached steps and kept artifacts, shipped as a Change.

The pipeline is TypeScript in your repo. The platform evaluates it in a sandbox, runs your steps in containers, then adds its own evidence steps. Every option is in the [CI DSL reference](/docs/reference/ci-dsl).

## 1. Know the shape

```ts
type RunnerSpec = {
  name: string;
  command: string;
  cache?: { inputs: string[] };
  artifacts?: { name: string; paths: string[] }[];
};
type Step = { runner(spec: RunnerSpec): Promise<Step> };

export default async (ci: Step) => {
  const install = await ci.runner({
    name: "install",
    command: "pnpm install --frozen-lockfile",
    cache: { inputs: ["**/package.json", "pnpm-lock.yaml"] },
  });
  await Promise.all([
    install.runner({ name: "lint", command: "pnpm run lint" }),
    install.runner({ name: "test", command: "pnpm run test" }),
  ]);
};
```

- `ci.runner()` starts from a fresh checkout. `install.runner()` starts from the `install` step's container snapshot, so `node_modules` is already there.
- `await` orders steps; steps started together (`Promise.all`) run in parallel.
- Keep the file self-contained: no imports. It runs in plan mode without `node_modules`.

## 2. Cache a step

A step with `cache.inputs` is skipped when none of the files matching those globs changed; its last result and snapshot are reused.

```ts
install.runner({
  name: "typecheck",
  command: "pnpm run typecheck",
  cache: { inputs: ["src/**", "tsconfig.json", "pnpm-lock.yaml"] },
});
```

Install-like root steps (`pnpm install`, `npm ci`) share their snapshot across repos with byte-identical inputs (`cacheScope: "global"`): that is why template repos install in seconds. Set `cacheScope: "repo"` to keep a snapshot to your repo.

## 3. Keep build output (artifacts)

```ts
install.runner({
  name: "build",
  command: "pnpm run build",
  artifacts: [{ name: "bundle", paths: ["dist"] }],
});
```

After the command succeeds, each artifact is uploaded as a tarball. A missing path fails the step unless the artifact sets `optional: true`. The `bundle` artifact is what a rollout deploys ([Deploy and roll out](/docs/guides/deploy-and-roll-out)); previews start from the build step's snapshot.

## 4. Environment, size and time

```ts
install.runner({
  name: "e2e",
  command: "pnpm run e2e",
  cwd: "apps/web",
  env: { NODE_OPTIONS: "--max-old-space-size=4096" },
  instance: "standard-3",
  timeoutMinutes: 20,
});
```

Steps never get secrets or platform tokens; `env` keys starting with `GITTIFACTS_`, `GIT_CONFIG_` or `ARTIFACTS_` are refused. Unclaimed repos reach package registries only and are capped at `standard-2`.

## 5. Run only affected tests in the merge queue

In merge-queue batch runs, every user step gets `GITTIFACTS_TEST_TARGETS`: the test files affected by the batch, one per line. A test command that ignores it runs everything, which is always correct. To use it:

```sh
pnpm exec vitest run $(printf '%s\n' "$GITTIFACTS_TEST_TARGETS" | tr '\n' ' ')
```

Evidence steps choose their own tests: `test-run`, `red-green` and `coverage` run the test files that reach the Change, and the whole suite when that's unknown ([Evidence](/docs/concepts/evidence#what-runs)).

## 6. Ship the edit

`.platform/**` is a sensitive path: the Change gets a full review (Lane 2) and needs a human's approval. The pipeline is read from the Change's **base** commit, so your edit applies to Changes that start after it merges, not to the Change that makes it.

```text
start_change({ repoId: "3fk2q8wz7m1x0c5v9nbd", title: "CI: add e2e step", category: "chore" })
```

## When the pipeline itself fails

| Symptom in `get_change_status` | Cause |
|---|---|
| A warning or failure naming `.platform/ci.ts` | The file threw or exported no function in plan mode; the platform falls back to the default pipeline or fails the run with the message verbatim |
| A step name is refused | Names are letters, digits, `.`, `_`, `-`; `prepare`, `plan` and `finalize` are reserved |
| `install` fails with a lockfile error | Commit the lockfile that matches `package.json` |
| A step named `unclaimed-limits` failed | An unclaimed repo ran out of CI minutes: claim it |

Long steps are durable: each runs as a job on its runner, and the run checks on it with short calls. A dropped connection is retried, and a step attempt that dies re-attaches to the job that is still running instead of starting it again.

No file at all? The platform detects a default pipeline from `package.json` (install, then lint, typecheck, test and build when those scripts exist).
