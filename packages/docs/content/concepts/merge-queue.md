---
title: Merge queue
description: The only writer of the default branch. Batches Changes speculatively, resolves conflicts with an agent, and keeps main green.
order: 6
audience: both
---

# Merge queue

The merge queue is the only principal that writes the default branch. It is built for hundreds of agent Changes a day: it tests Changes together, lands independent ones in parallel, and fixes textual conflicts with a resolver agent instead of bouncing them back.

## Invariants

1. **Main is never red.** Main only advances to a tree that passed every required check on exactly that tree.
2. **Evidence describes what lands.** Evidence and lane are recomputed on the merged tree, after rebase and resolution.
3. **Every regression is attributable** to one Change, which can be switched off alone.
4. **No self-approval**, including for conflict resolutions.

## How it works

```text
approved Changes ─► conflict graph ─► independent tracks (in parallel)
                                         └─ speculative batches: main + c1..c4, built on in-flight batches
                                              ├─ pass → compare-and-swap main → merged
                                              └─ fail → bisect → eject only the culprit (with a fix)
textual conflict ─► resolver agent (not the author) ─► re-evidence, re-classify (lane can only rise)
```

- **Affected sets.** Each Change's touched files, their reverse-dependency closure and the tests that cover them decide which Changes conflict. Unknown means "conflicts with everything".
- **Flaky tests** are re-run on the batch tree and on main before a failure counts. A test that also fails on main is quarantined, which raises the Change to at least Lane 1.
- **Priority:** reverts and incident fixes, then security fixes, then Lanes 0, 1, 2, with aging so nothing starves. Each agent session gets a fair share.
- **Freezes:** while an automatic revert is in progress, only reverts and incident fixes land.

## What agents see

A Change joins the queue on its own once it is approved (or is Lane 0 with Lane 0 on). `enqueue` only adds options: priority, stacks (`dependsOn`), plan groups that land together.

```text
queue_status({ changeId: "7h2kd9x0qw3m5z8r1vtc" })
```

Expected: `state`, `position`, `etaSeconds` and `reason` in words, such as "waiting on conflicting Change 6f8a2kq9w3x7m0d1z5rb in track 2". An ejection carries `{ code, message, fix }` with the next call to make.

Status: built and tested; the live end-to-end run on the hosted platform is pending. Guide: [Merge queue](/docs/guides/merge-queue).
