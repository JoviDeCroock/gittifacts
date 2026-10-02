---
title: Plans
description: A Plan is the intent a human approves before work starts. It is the main human checkpoint.
order: 1
audience: both
---

# Plans

A **Plan** says what a change is for and how a reviewer will know it worked. An agent or a human drafts it; a human who is not the author approves it. Reviewing the diff later becomes a conformance check against the approved Plan.

## What a Plan holds

| Field | What it is for |
|---|---|
| `title`, `intent` | The problem and the outcome you want. |
| `acceptanceCriteria[]` | Observable results a reviewer can check ("GET /time returns ISO 8601"). |
| `outOfScope[]` | What the change must not do. |
| `riskDeclarations[]` | Known risks, `{ area, description }`. |
| `scopePaths[]` | Globs of the paths the change will touch. A Change outside them raises its lane (scope drift); leaving them out blocks Lane 0. |
| `affectedRoutes[]` | Routes to screenshot on the preview. |
| `supersedes` | The Plan this one replaces. |

## Lifecycle

```text
draft ──approve (human, not the author)──► approved ──► superseded (by a newer Plan)
  └────reject (with a reason)────────────► rejected
```

- Approval is signed by the platform on the human's behalf and recorded in the audit log.
- A Change that names an approved Plan (`planId`) is checked against it.
- A Change without a Plan can reach Lane 1 or 2, never Lane 0, unless the repo's policy allows a planless category (`dependency-patch`, `pure-revert`, `verified-transform`).

## Draft one

```text
create_plan({ repoId: "3fk2q8wz7m1x0c5v9nbd", title: "Add /time", intent: "Clients need the server time in ISO 8601 to schedule jobs.", acceptanceCriteria: ["GET /time returns an ISO 8601 timestamp", "Existing routes are unchanged"], scopePaths: ["src/**", "test/**"] })
```

Expected: `{ "plan": { "id": "4p8n2b7dq0x6w3k9m1zs", "status": "draft", … }, "nextSteps": [ … ] }`. Then ask a human to approve it; you can't.

Reference: [`create_plan`](/docs/reference/mcp-changes#create_plan), [HTTP plans API](/docs/reference/http-repos#plans).
