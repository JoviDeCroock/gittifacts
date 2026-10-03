---
title: Deploy and roll out
description: Set a deploy target, guard risky code with isChangeEnabled, ship in gradual stages, watch for regressions, and kill or revert a Change.
order: 17
audience: both
group: Daily work
---

# Deploy and roll out

Merging and deploying are separate steps. Once a repo has a deploy target, every merged Change ships through a gradual rollout behind its own flag and is watched for regressions. A regression ends in a revert without anyone waking up.

Rollouts run on the hosted platform. Its end-to-end test (`scripts/e2e/m4.ts`) passes live: a Change that throws for some traffic is detected, its flag killed, the version rolled back and a revert Change opened, with no human involved.

## 1. Make the build deployable

The rollout deploys the build step's `bundle` artifact: a modules-only Worker. The `workers-api` template already declares it:

```ts
install.runner({
  name: "build",
  command: "pnpm run build",
  artifacts: [{ name: "bundle", paths: ["dist"] }],
});
```

Bundles may declare plain variables only; resource bindings are refused. Every deployed version gets two bindings from the platform: `FLAGS` (your project's own flag app) and `VERSION` (version metadata). **Coming soon:** deploying asset-based projects (`preact-app`, `static-site`).

## 2. Set the deploy target

A human owner of a claimed project names the Worker. There is no MCP tool: agents can't hold `repo:admin`.

```sh
curl -s -X PATCH https://<host>/api/v1/repos/3fk2q8wz7m1x0c5v9nbd/deploy-target \
  -H "Cookie: $GITTIFACTS_SESSION" -H "Content-Type: application/json" \
  -d '{"script":"api"}'
```

Expected: `200`. Rollouts go to the Worker `gf-3fk2q8wz7m1x0c5v9nbd-api` in the platform's account; the first one creates it with a `workers.dev` URL. `{"script":null}` clears the target. Unclaimed projects get `403 unclaimed-limit`.

## 3. Guard risky code with the Change's flag

Every merged Change gets a flag `change-<changeId>`, on while it rolls out. Code that reads it can be switched off in about 30 seconds without a deploy:

```ts
import { isChangeEnabled } from "./flags";

export async function handleTime(env: Env): Promise<Response> {
  if (await isChangeEnabled(env, "7h2kd9x0qw3m5z8r1vtc")) {
    return Response.json({ time: new Date().toISOString() });
  }
  return new Response("Not found", { status: 404 });
}
```

`src/flags.ts` ships with the `workers-api` template. Locally, in tests and in previews there is no `FLAGS` binding, so the Change counts as on. A Change whose code reads its own flag can share a deploy train with other flagged Changes; one that can't be switched off alone deploys alone.

## 4. Tune the rollout

In `.platform/policy.ts` (a Lane 2 Change, read from the base branch):

```ts
export default {
  rollout: {
    stages: [5, 25, 100],
    stageMinutes: 10,
    watchMinutes: 30,
    maxErrorRateIncrease: 0.01,
    maxNewIssueGroups: 0,
    minRequests: 50,
  },
};
```

Each stage sets the traffic split, waits `stageMinutes`, then compares the new version with the previous one: error rate (with at least `minRequests`) and new Workers Issues groups. After 100% the platform watches for `watchMinutes`.

Two signals feed the check. Workers Issues pushes each new error group of your Worker to the platform as it is detected, so a regression can be caught between polls. Workers Logs are polled every 30 seconds as the fallback.

## 5. Watch it

```text
list_issues_for_change({ changeId: "7h2kd9x0qw3m5z8r1vtc" })
```

Humans watch `https://<host>/changes/<changeId>/rollout`: the stages, the health checks and every step as a signed audit event. Over HTTP: `GET /api/v1/changes/<changeId>/rollout` returns `{ rollout, timeline, policy }`.

## 6. When it regresses

The platform turns the flag off, rolls back to the previous version and opens a **revert Change**: the exact inverse of the merge. A verified pure revert auto-merges when `autoMergeVerifiedReverts` is on (the default). While it lands, the merge queue freezes for everything except reverts and incident fixes. A revert that itself regresses is rolled back and left to a human.

## 7. Kill it by hand

A maintainer or owner pulls the kill switch on the rollout screen (**Kill switch**), or:

```sh
curl -s https://<host>/api/v1/changes/7h2kd9x0qw3m5z8r1vtc/kill \
  -H "Cookie: $GITTIFACTS_SESSION" -H "Content-Type: application/json" \
  -d '{"reason":"p95 latency doubled on /time"}'
```

Same result as an automatic regression: flag off, roll back, revert Change, all audited.
