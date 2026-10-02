---
title: Tours
description: When a human reviews, they get a guided tour from a separate reviewer agent, ordered by risk and anchored to evidence.
order: 5
audience: both
---

# Tours

A **tour** replaces reading a diff top to bottom. A reviewer agent that is not the author writes it from the Plan, the diff and the evidence; it never sees the author's own summary. Lane 1 and Lane 2 Changes get one, and so do shadow-mode Lane 0 candidates.

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
- A Lane 1 tour reads on a phone in under three minutes.
- The tour JSON is validated against a schema. On failure it is regenerated once, then the Change escalates to Lane 2.
- A tour is tied to a head. A new push makes it `stale` until the reviewer agent writes a new one.

## Budget

Model calls go through AI Gateway with a per-Change budget (`policy.ai.budgetUsdPerChange`, default $0.50). Running out escalates the lane rather than skipping the tour. On the live platform a 5-stop tour costs about $0.015.

## Read one

```text
wait_for_change({ changeId: "ch_5mz1", until: "tour_ready", timeoutSec: 50 })
```

```text
get_tour({ changeId: "ch_5mz1" })
```

Humans read it in the web app at `/changes/<changeId>`. How to act on it: [Read and act on a tour](/docs/guides/review-a-tour).
