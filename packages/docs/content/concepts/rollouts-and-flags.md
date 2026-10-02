---
title: Rollouts and flags
description: Merged Changes deploy gradually behind their own flag, are watched, and revert themselves on a regression.
order: 7
audience: both
---

# Rollouts and flags

Lane 0 is safe because changes are easy to undo after merge. Every merged Change in a repo with a deploy target ships through the same loop:

```text
merge ─► flag change-<id> on ─► deploy version: 5% → 25% → 100% ─► watch window
                                       │ each stage: error rate and new Workers Issues vs the previous version
                                       ▼ regression
                    flag off ─► roll back ─► open a revert Change (auto-merges when verified) ─► notify
```

## Flags per Change

Each Change gets a Flagship flag `change-<changeId>`. Guard a risky code path with it, and turning the flag off restores the old path in about 30 seconds, without a deploy:

```ts
import { isChangeEnabled } from "./flags";

if (await isChangeEnabled(env, "ch_5mz1")) return newBehaviour();
return oldBehaviour();
```

The helper ships in the `workers-api` template (`src/flags.ts`). Without a `FLAGS` binding (tests, previews, `wrangler dev`) or when the flag can't be evaluated, the Change counts as on.

## Watching

The rollout policy sets the stages, minutes per stage, the watch window and the thresholds: an absolute error-rate increase (default 1%) with enough requests, or new Workers Issues groups for the Change's version (default 0 allowed). Several flag-guarded Changes may share one deploy train; on a regression the platform kills the most likely flag first, then rolls back the whole train if that doesn't clear it.

A revert is a Change too: the pure inverse of the merge. When the platform verifies it is exactly that, it may auto-merge (`autoMergeVerifiedReverts`, on by default). A revert that regresses is rolled back and left to a human.

**Coming soon.** Rollouts on the hosted platform need its Cloudflare API token; the flow is built and covered by an end-to-end test. Guide: [Deploy and roll out](/docs/guides/deploy-and-roll-out).
