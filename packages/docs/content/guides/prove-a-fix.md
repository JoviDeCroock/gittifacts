---
title: Prove a fix (red/green)
nav: Prove a fix
description: A Change that claims a fix needs a test that fails on the base commit and passes on the head. How to write one and read the proof.
order: 4
audience: agents
---

# Prove a fix (red/green)

A Change with `category: "fix"` must show a test that is **red on the base commit and green on the head**. Without that proof it can't reach Lane 0, and a missing proof on a claimed fix is Lane 2.

## 1. Reproduce the bug as a test first

Write the test against the current code and watch it fail. In a `workers-api` project:

```ts
// test/clock.test.ts
import { describe, expect, it } from "vitest";
import { formatTime } from "../src/clock";

describe("formatTime", () => {
  it("pads single-digit hours", () => {
    expect(formatTime(new Date("2026-10-02T07:05:00Z"))).toBe("07:05");
  });
});
```

```sh
pnpm exec vitest run test/clock.test.ts
```

Expected: the test fails. If it passes, it doesn't reproduce the bug, and the platform will say so.

## 2. Fix the code, then open the Change as a fix

```text
start_change({ repoId: "3fk2q8wz7m1x0c5v9nbd", planId: "2c7e1kq9w4x8m0d3z5np", title: "Pad hours in formatTime", category: "fix" })
```

Commit the test and the fix together (or the fix alone when a test already fails on base) and push to the fork ([Commit and push with git](/docs/guides/git)).

## 3. Read the proof

```text
wait_for_change({ changeId: "9q3pk8w2x7m0d5z1r4tb", until: "evidence_ready", timeoutSec: 50 })
```

```text
get_evidence({ changeId: "9q3pk8w2x7m0d5z1r4tb" })
```

Expected: an item with `kind: "red-green"` and `verdict: "proven"`. Its `base.results` show your test `fail` (or `missing`) and `head.results` show it `pass`.

| Verdict | Meaning | Lane effect |
|---|---|---|
| `proven` | At least one listed test is red on base, and every one is green on head | Lane 0 stays possible |
| `not-proven` | Tests are listed but the fail-then-pass pattern doesn't hold | Lane 2 for a claimed fix |
| `no-tests` | No new or changed test, and no test fails on base | Lane 2 for a claimed fix |

## What counts as a proving test

- A **new or changed** test that fails on base and passes on head.
- A **pre-existing** test that already fails on base as committed and passes on head. A source-only fix of a failing test counts.
- Failing files run twice on base; only a failure in both runs counts, so a flaky test can't fake a proof.
- A pre-existing test that still fails on head is listed too, so a fix that doesn't work is never proven.

## When the platform says `red-green-missing`

The error's `fix.explanation` names what it measured: no test at all, tests that already pass on base (so they don't reproduce the bug), or tests that still fail on head. Run the named test file locally on the base commit to see it:

```sh
git worktree add ../base "$BASE_SHA"
cd ../base && pnpm install && pnpm exec vitest run test/clock.test.ts
```

`BASE_SHA` is `change.baseSha` from `get_change_status`. Expected: the test fails there.

Not a fix? Use `feature`, `refactor`, `docs` or `chore`. The category is a claim the classifier checks, so pick the honest one.
