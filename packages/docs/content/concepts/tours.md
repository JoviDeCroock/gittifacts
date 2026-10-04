---
title: Walkthroughs
description: When a human reviews, they get a guided walkthrough from a separate reviewer agent, ordered by risk and anchored to evidence.
order: 5
audience: both
---

# Walkthroughs

A **walkthrough** replaces reading a diff top to bottom. A reviewer agent that is not the author writes it from the Plan, the diff and the evidence; it never sees the author's own summary. Changes in quick or full review (Lane 1 or 2) get one, and so do auto-merge candidates while the repo is calibrating.

## Shape

```text
Tour
├── leastConfident[]   what the reviewer is unsure about (never empty)
├── notDone[]          what the Change doesn't cover (never empty)
└── stops[]            ordered: intent → behavior before/after → riskiest hunk → its proof → gaps
     └── stop: title, why, hunkRefs[], evidenceRefs[], verdict
```

| Verdict | Meaning |
|---|---|
| `proven` | The claim cites evidence (a test, a measurement, a screenshot) |
| `unproven` | No evidence backs the claim. Every claim without an evidence reference is unproven |
| `risk` | Something a human should look at closely |

- Hunks a verified reproducible transform produced collapse into one stop.
- A quick-review walkthrough reads on a phone in under three minutes.
- The walkthrough JSON is validated against a schema. On failure it is regenerated once, then the Change escalates to a full review (Lane 2).
- A walkthrough is tied to a head. A new push makes it `stale` until the reviewer agent writes a new one.

## Budget

Model calls go through AI Gateway with a per-Change budget (`policy.ai.budgetUsdPerChange`, default $0.50). Running out escalates the lane rather than skipping the walkthrough. On the live platform a 5-stop walkthrough costs about $0.015.

## Read one

```text
wait_for_change({ changeId: "7h2kd9x0qw3m5z8r1vtc", until: "tour_ready", timeoutSec: 50 })
```

```text
get_tour({ changeId: "7h2kd9x0qw3m5z8r1vtc" })
```

Humans read it in the web app at `/changes/<changeId>`. How to act on it: [Read and act on a walkthrough](/docs/guides/review-a-tour).
