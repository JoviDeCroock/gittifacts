---
title: "Limits and quotas"
description: "Every limit the platform enforces: unclaimed projects, remote workspaces, waits, tokens and sessions, rate limits and the merge queue."
order: 53
audience: both
generated: true
---

# Limits and quotas

Claiming a project lifts every unclaimed limit at once. Operators can override the unclaimed defaults with the `UNCLAIMED_LIMITS` (JSON) and `UNCLAIMED_TTL_DAYS` variables. A refused call returns `429 quota-exceeded` or `403 unclaimed-limit` with a fix that names the claim link ([error codes](/docs/reference/errors)).

> Generated from `apps/platform/src/limits/config.ts`, `apps/platform/src/workspace/model.ts`, `packages/mcp/src/tools/workspace.ts`, `apps/platform/src/oauth/*.ts`, `packages/merge-queue/src/config.ts` by `pnpm --filter @app/docs generate`. Don't edit this page by hand: change the code and regenerate.

## Unclaimed projects

| Limit | Default | Meaning |
| --- | --- | --- |
| `ttlDays` | 7 | Days until an unclaimed project and everything in it is deleted, unless a human claims it. |
| `ci.minutesPerDay` | 60 | CI minutes per project per UTC day. |
| `ci.minutesPerRun` | 10 | Longest single CI run. |
| `ci.maxLogBytes` | 2 MB | CI log kept per step. |
| `ci.maxArtifactBytes` | 20 MB | Largest build artifact. |
| `ci.instance` | standard-2 | Largest container size a step gets. |
| `storageBytes` | 200 MB | Bytes the platform stores for the project (CI logs, build artifacts), all time. |
| `artifactsOpsPerDay` | 300 | Platform-mediated Artifacts operations (forks, push/clone tokens, imports) per UTC day. |
| `maxOpenChanges` | 5 | Open Changes (each one a fork) an unclaimed project may have at once: bounds the git storage it can hold, which Artifacts can't report (1 GB per repo is Artifacts' own cap). |
| `globalCiMinutesPerDay` | 1500 | Platform-wide cap on all unclaimed projects' CI minutes per UTC day (cost bound). |
| `perIp.ciMinutesPerDay` | 120 | Aggregate over every unclaimed project created from one IP (or IPv6 /64). |
| `perIp.storageBytes` | 500 MB | Aggregate over every unclaimed project created from one IP (or IPv6 /64). |
| `perIp.artifactsOpsPerDay` | 600 | Aggregate over every unclaimed project created from one IP (or IPv6 /64). |
| `creation.ipHour` | 3 per hour | Credential-less create_project: token buckets per IP, per ASN and platform-wide. |
| `creation.ipDay` | 10 per day | Credential-less create_project: token buckets per IP, per ASN and platform-wide. |
| `creation.asnHour` | 30 per hour | Credential-less create_project: token buckets per IP, per ASN and platform-wide. |
| `creation.asnDay` | 200 per day | Credential-less create_project: token buckets per IP, per ASN and platform-wide. |
| `creation.globalHour` | 300 per hour | Credential-less create_project: token buckets per IP, per ASN and platform-wide. |
| `creation.globalDay` | 2000 per day | Credential-less create_project: token buckets per IP, per ASN and platform-wide. |
| `creation.evalRun` | 3 per 7 days | One eval run (signed `x-gittifacts-eval-run`, src/limits/eval-traffic.ts): replaces the IP and ASN buckets for that run; the global ones still apply. |
| `requestsPerMinute` | 120 | Requests per minute per unclaimed token (mirrors the UNCLAIMED_TOKEN_LIMITER binding). |

## Remote workspaces

| Limit | Claimed | Unclaimed | Meaning |
| --- | --- | --- | --- |
| `ttlMs` | 60 min | 30 min | Hard end of a workspace session, from when it was opened. |
| `idleMs` | 10 min | 5 min | Idle time before the workspace sleeps (snapshot + stop). |
| `instance` | standard-2 | standard-1 | Container size. |
| `cpuSecondsPerDay` | 60 vCPU-min/day | 30 vCPU-min/day | vCPU-seconds of container time per project per UTC day (null: unlimited). |
| `maxOpen` | 1 | 1 | Workspaces open at once per project. |
| `maxExecTimeoutSec` | 30 min | 10 min | Longest `ws_exec` timeout. |
| `maxOutputBytes` | 64 KB | 32 KB | stdout and stderr of one ws_exec, each. |

Per call:

| Limit | Value |
| --- | --- |
| `maxCommandChars` | 16384 |
| `maxPathChars` | 1024 |
| `maxWriteBytes` | 1 MB |
| `maxTimeoutSec` | 30 min |
| `defaultTimeoutSec` | 2 min |
| `maxMessageChars` | 10000 |

## Waiting

| Call | Timeout |
| --- | --- |
| `wait_for_change` | max 600 s per call. Default 50. Keep it below your MCP client's request timeout (60s in the SDK default) and call again if not reached. |
| `wait_for_merge` | max 55 s per call. Default 50 (your MCP client times out at 60 s). Call again while reason is "timeout". |
| `gittifacts wait` | re-issues the long-poll until `--timeout` (default 600 s) |

## Tokens and sessions

| What | Value |
| --- | --- |
| OAuth access token (agents, integrations) | 60 min |
| Agent session length (human picks) | 1, 7, 30, 90 days (default 30) |
| Authorization code | 5 min, single use |
| Authorization request | 10 min |
| Device code | 15m, poll every 5s |
| Integration refresh token | 180 days after its last rotation |
| Agent scopes that can be delegated | `repo:read`, `plan:create`, `change:create` |
| Default delegated scopes | `repo:read`, `change:create` |
| Never delegated | `repo:admin`, `plan:approve`, `change:review`, `policy:admin` |

## Webhook delivery

Up to 8 attempts, retried after 10 s, 30 s, 2 min, 10 min, 30 min, 60 min, 120 min. User agent `gittifacts-Hookshot/1`.

## Merge queue

| Setting | Default | Meaning |
| --- | --- | --- |
| `maxBatchSize` | 4 | Entries per batch (a land-together unit may exceed it). Fixed: prediction-driven sizing and ordering lost to it in the simulator (see sim/merge-queue/report.md) and was removed. |
| `maxSpeculationDepth` | 16 | In-flight (untested) batches a new batch may speculate on, itself included (1 = no speculation). |
| `batchHoldMs` | 0 min | A batch built on an in-flight predecessor can't land before it anyway, so it may stay open for joiners this long after its predecessors started (fewer CI runs). Off by default: with direct carrying it cost more latency than the CI it saved (see sim/merge-queue/report.md). |
| `maxInFlightBatches` | 128 | In-flight chain batches across the repo. Backpressure: while it is reached, arrivals wait and are batched together when a slot frees (bigger batches, fewer CI minutes). |
| `coBatch` | true | Independent units placed in the same pass may share one batch (saves CI; couples their fate). |
| `maxTracks` | 32 |  |
| `maxConcurrentRuns` | 64 |  |
| `maxLandingDepth` | 16 | Revalidation (landing) batches in flight on top of each other. |
| `maxLandingMembers` | 2 | Passed batches revalidated together in one landing batch. Small landing batches keep the impacted-target runs short (they're on the landing critical path); the pipeline overlaps them. |
| `bisectProbes` | 3 | Parallel prefix probes per bisection round. |
| `agingStepMs` | 15 min | Every `agingStepMs` of waiting raises an entry one priority class (never above `security`). |
| `maxInFlightPerSession` | 12 | Entries one agent session may have in batches at once. |
| `resolutionMaxAttempts` | 2 |  |
| `affectedSetTimeoutMs` | 15 min | An affected set not computed after this long is treated as unknown (conflicts with all). |
| `runTimeoutMs` | 90 min | A CI run with no result after this long is cancelled and retried. |
| `buildTimeoutMs` | 15 min | A batch tree still building after this long is rebuilt. Building is git work (a replay in the scratch repo), minutes at most; the shell drops a BuildBatchTree that keeps failing, so without this the batch (and every landing behind it) waited out `runTimeoutMs` (M5 dogfood: 90 min). |
| `maxInfraRetries` | 3 |  |
| `initialCiDurationMs` | 10 min | Prior for the CI duration estimate (ETAs) before any run has finished. |
| `mainLogLimit` | 2000 | Landed main commits remembered for staleness checks. |
| `resultCacheSize` | 256 | Passing full runs remembered by tree sha (`features.resultCache`). |
| `earlyLandingLeadMs` | 150 s | How far ahead of its expected finish a running batch may join the landing pipeline. |
| `retainTerminal` | 500 | Terminal entries kept for status queries. |
