---
title: Concepts
description: The nine ideas the platform is built on, one short page each.
order: 0
audience: both
---

# Concepts

One rule drives every design choice:

> Humans approve intent. Machines prove conformance. The platform routes each change to the cheapest review that is still safe, and makes changes easy to undo after merge.

```text
Plan ──approve──► Change ──push──► CI + evidence ──classify──► lane
(human)           (agent)          (signed)                    0 · 1 · 2
                                                                 │
          revert ◄── watch ◄── rollout ◄── merge queue ◄─────────┘
                                            (auto-merge alone; quick and full review after a human approves)
```

<!-- pages -->
