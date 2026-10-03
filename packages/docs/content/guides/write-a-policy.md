---
title: Write a policy (.platform/policy.ts)
nav: Write a policy
description: Tune thresholds, sensitive paths, planless categories and rollouts; run in shadow mode; and turn on Lane 0 once humans agree with the classifier.
order: 46
audience: humans
group: Set up a repo
---

# Write a policy (`.platform/policy.ts`)

The policy decides what each lane demands. It lives in the repo, it is read from the **base** commit of every Change (a Change can't relax its own rules), and editing it is always a Lane 2 Change that a human approves. Every field and default: [Policy schema](/docs/reference/policy).

## 1. Start from the generated file

New projects get a commented policy with the defaults. A minimal one is a plain object literal with no imports:

```ts
export default {
  version: 1,
  sensitivePaths: ["**/auth/**", "**/payments/**", "**/migrations/**", ".platform/**"],
  thresholds: { changedLineCoverage: 0.8, mutationScore: 0.6, lane0MaxDiffLines: 150 },
  previewRoutes: ["/", "/settings"],
};
```

Fields you leave out take their defaults.

## 2. Tune what you need

| Goal | Field |
|---|---|
| Force full review on more paths | `sensitivePaths` (globs). Adding paths is safe; removing them lowers lanes |
| Demand better tests for Lane 0 | `thresholds.changedLineCoverage`, `thresholds.mutationScore` |
| Keep Lane 0 to small diffs | `thresholds.lane0MaxDiffLines`, `thresholds.lane0MaxFiles` |
| Send big Changes to full review | `thresholds.lane1MaxDiffLines`, `thresholds.lane1MaxFiles` |
| Allow Lane 0 without a Plan for narrow cases | `planlessLane0: ["dependency-patch", "pure-revert", "verified-transform"]` |
| Screenshot routes on every preview | `previewRoutes` |
| Slower or faster rollouts | `rollout.stages`, `rollout.stageMinutes`, `rollout.watchMinutes` |
| Stricter regression detection | `rollout.maxErrorRateIncrease`, `rollout.maxNewIssueGroups`, `rollout.minRequests` |
| Cap reviewer-agent spend | `ai.budgetUsdPerChange` (exceeding it escalates the lane) |
| Registries-only network for workspaces | `sandbox: { network: "registries-only" }` |

## 3. Ship it as a Change

```text
start_change({ repoId: "3fk2q8wz7m1x0c5v9nbd", title: "Policy: screenshot /settings", category: "chore" })
```

Push the edit. Expected: Lane 2 with reason `policy.changed` and `requiresHumanApproval: true`. Once a human approves and it merges, Changes based on the new default branch follow it.

## 4. Watch shadow mode

Every repo starts in shadow mode: Lane 0 is off, but the classifier still computes it. Lane-0 candidates go to a reviewer as Lane 1, and the reviewer records the lane they would have picked. The repo screen shows the agreement ratio and how many more agreeing reviews are needed.

Defaults: 95% agreement (`shadow.agreementThreshold`) over at least 25 reviewed candidates (`shadow.minSamples`). Over HTTP, `GET /api/v1/repos/<repoId>` returns `shadow: { samples, agreed, ratio, needed, eligibleToEnableLane0 }`.

## Turn on Lane 0

1. **Earn agreement.** Keep reviewing until `eligibleToEnableLane0` is `true`.
2. **Check the file.** A policy file can force Lane 0 off (`lane0Enabled: false`) but never on, and the generated policy leaves the key out. Projects created before 2026-10-02 have `lane0Enabled: false` in theirs: remove that line in a policy Change (step 3) first, or the next commit on the default branch turns Lane 0 off again.
3. **Flip the toggle.** An owner chooses **Turn on Lane 0** on the repo screen, or:

```sh
curl -s -X PATCH https://<host>/api/v1/repos/3fk2q8wz7m1x0c5v9nbd/lane0 \
  -H "Cookie: $GITTIFACTS_SESSION" -H "Content-Type: application/json" \
  -d '{"enabled":true}'
```

Expected: `200` with `repo.policy.lane0Enabled: true`. Before the threshold: `409 threshold-not-met`, with how many more agreeing reviews are needed. Unclaimed projects: `403`.

From then on, Changes that pass every Lane-0 gate merge without a human and roll out behind their own flag. **Return Lane 0 to shadow mode** (`{"enabled":false}`) at any time.

## Things a policy can't do

- Lower a lane computed from a missing or errored signal: unknown always escalates.
- Let an agent approve anything, or a human approve their own work.
- Turn on Lane 0 or auto-merge for an unclaimed project.
