---
title: Read and act on a walkthrough
nav: Review a walkthrough
description: For reviewers. What to read first, how to judge each stop, and how to approve, request changes or reject - in the app or over HTTP.
order: 32
audience: humans
group: Review
---

# Read and act on a walkthrough

**You'll have:** a decision on a Change in quick or full review (quick or full review (Lane 1 or 2)): approved, changes requested, or rejected.

You review Changes in quick review (Lane 1) and full review (Lane 2), and auto-merge candidates while the repo is calibrating. The walkthrough tells you where the risk is; your job is to judge it against the approved Plan, not to re-read every line.

## 1. Open the Change

An agent's `request_review` is recorded in the audit log, not sent to you as a message, so the agent hands you the link: `https://<host>/changes/<changeId>`. The repo screen also groups open Changes by lane. On a phone, the decision bar sits at the bottom of the screen.

## 2. Read the handover first

Above the stops, the reviewer agent lists:

- **Least confident:** what it couldn't verify. Start here.
- **Not done:** what the Change doesn't cover, compared with the Plan.

Neither list is ever empty. "Nothing" comes with a reason.

## 3. Walk the stops

Stops run from intent, through behavior before and after, to the riskiest hunk, its proof, and what isn't covered. The station strip shows each stop's verdict:

| Mark | Verdict | What to do |
|---|---|---|
| Filled green disc | `proven`: the claim cites evidence | Open the evidence link if you doubt it; otherwise move on |
| Dashed ochre ring | `unproven`: no evidence backs it | Read the hunk; decide whether the claim matters |
| Carmine triangle | `risk` | Read closely; this is why the Change is in this lane |

Each stop links to its hunks (with old and new line numbers) and its evidence items. **Why this lane** shows every reason and the lane it forced; anything not measured is marked "Not measured", never green.

## 4. Decide

| Decision | Effect |
|---|---|
| **Approve change** | Signed; the Change joins the merge queue, then rolls out behind its flag |
| **Request changes** | Your comment goes to the author agent; it pushes a new head and the walkthrough is rewritten |
| **Reject change** | Closed for good; a retry needs a new Change |

Optionally pick **the lane you would have chosen** (0, 1, 2 or no call). That answer is how calibration learns whether auto-merge can be trusted in this repo.

Rules: you can't review a Change you authored, and an approval binds to the head you reviewed. If the agent pushes again, the walkthrough shows as stale and you review the new head.

## Over HTTP

The same decision, with your session cookie (agents can't call this):

```sh
curl -s https://<host>/api/v1/changes/7h2kd9x0qw3m5z8r1vtc/review \
  -H "Cookie: $GITTIFACTS_SESSION" \
  -H "Content-Type: application/json" \
  -d '{"decision":"approve","humanLane":1,"comment":"Matches the plan; /time is covered by test/time.test.ts."}'
```

`decision` is `approve`, `request-changes` or `reject`. Expected: `200` with the updated `change`. Errors: `403 self-approval` for your own Change, `403 forbidden` for an agent, `409 stale-head` when the head moved.

Related: [Walkthroughs](/docs/concepts/tours), [Lanes](/docs/concepts/lanes).
