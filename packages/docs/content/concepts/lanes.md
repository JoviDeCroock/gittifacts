---
title: Lanes
description: Every Change gets a risk lane from objective signals. Lane 0 auto-merges, Lane 1 gets a glance, Lane 2 a full review.
order: 4
audience: both
---

# Lanes

The platform routes every Change to the cheapest review that is still safe. A pure, deterministic classifier reads the evidence, the base branch's policy, the Plan and the diff, and returns a lane plus every reason behind it.

| Lane | Review | Typical Changes |
|---|---|---|
| **0** | None: auto-merge (when the repo has turned Lane 0 on) | An approved Plan, proven fix, no API or dependency change, no sensitive paths, coverage and mutation above thresholds, small diff |
| **1** | An async glance at the tour, on a phone if you like | Additive API, moderate size, missing optional evidence |
| **2** | Full review | Breaking API, sensitive paths, new dependencies, migrations, a fix without red/green proof, scope drift, any signal that couldn't be evaluated |

## How the lane is decided

1. Each signal produces a reason with a stable code and the minimum lane it forces.
2. The lane is the maximum over all reasons.
3. A missing or errored signal raises the lane; nothing defaults downward.
4. LLM judgments and external checks may only raise a lane, never lower it.
5. The author's category ("only a bugfix") is an input, never the decision.

```text
get_change_status({ changeId: "7h2kd9x0qw3m5z8r1vtc" })
```

Expected (abbreviated): `classification.lane`, `classification.computedLane`, `classification.reasons[]` (each `{ code, lane, message }`) and a `checklist` of the Lane-0 gates, each `passed: true | false | null` (`null` means not measured).

All codes: [Lane reason codes](/docs/reference/lane-reasons).

## Shadow mode

Every repo starts with Lane 0 **off**. The classifier still computes `computedLane`, and a Change it puts in Lane 0 goes to a human as Lane 1 with `shadow: true`.

When the reviewer records the lane they would have picked, the platform counts agreement. Once agreement passes the policy's threshold (default 95% over at least 25 reviews), an owner can turn Lane 0 on. See [Write a policy](/docs/guides/write-a-policy#turn-on-lane-0).

## Fixed rules

- A Change touching `.platform/**` is always Lane 2 and needs a human approval (`requiresHumanApproval`).
- Policy is read from the base branch, never from the Change's head, so a Change can't relax its own rules.
- A failed CI run or an evidence signature that doesn't verify sets `blocked`: the Change can't merge at all.
- Unclaimed projects never auto-merge.
