---
title: Lanes
description: Every Change gets a review lane from objective reasons. Auto-merge (Lane 0), Quick review (Lane 1) or Full review (Lane 2).
order: 4
audience: both
---

# Lanes

The platform routes every Change to the cheapest review that is still safe. A pure, deterministic classifier reads the evidence, the base branch's policy, the Plan and the diff, and returns a lane plus every reason behind it.

| Lane | Review | Typical Changes |
|---|---|---|
| **Auto-merge** (Lane 0) | None: the evidence decides (once the repo has turned auto-merge on) | An approved Plan, proven fix, no API or dependency change, no sensitive paths, coverage and mutation above thresholds, small diff |
| **Quick review** (Lane 1) | A person reads the walkthrough and approves, on a phone if they like | Additive API, moderate size, missing optional evidence |
| **Full review** (Lane 2) | A person reads the diff, with the walkthrough as a guide | Breaking API, sensitive paths, new dependencies, migrations, a fix without red/green proof, scope drift, any measurement that couldn't be taken |

## How the lane is decided

1. Each measurement produces a reason with a stable code and the minimum lane it forces.
2. The lane is the maximum over all reasons.
3. A missing or errored measurement raises the lane; nothing defaults downward.
4. LLM judgments and external checks may only raise a lane, never lower it.
5. The author's category ("only a bugfix") is an input, never the decision.

```text
get_change_status({ changeId: "7h2kd9x0qw3m5z8r1vtc" })
```

Expected (abbreviated): `classification.lane`, `classification.computedLane`, `classification.reasons[]` (each `{ code, lane, message }`) and a `checklist` (the auto-merge checklist), each `passed: true | false | null` (`null` means not measured).

All codes: [Lane reason codes](/docs/reference/lane-reasons).

## Calibrating

Every repo starts **calibrating**: auto-merge is off. The classifier still computes `computedLane`, and a Change it would auto-merge goes to a human as a quick review (Lane 1), with `shadow: true` in the API.

When the reviewer records the lane they would have picked, the platform counts agreement. Once agreement passes the policy's threshold (default 95% over at least 25 reviews), an owner can turn auto-merge on. See [Write a policy](/docs/guides/write-a-policy#turn-on-auto-merge).

## Fixed rules

- A Change touching `.platform/**` always gets a full review (Lane 2) and needs a human approval (`requiresHumanApproval`).
- Policy is read from the base branch, never from the Change's head, so a Change can't relax its own rules.
- A failed CI run or an evidence signature that doesn't verify sets `blocked`: the Change can't merge at all.
- Unclaimed repos never auto-merge.
