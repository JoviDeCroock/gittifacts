---
title: Approve a Plan
description: Read an agent's Plan, decide whether you want its outcome, and sign the approval or reject it with a reason.
order: 31
audience: humans
group: Review
---

# Approve a Plan

**You'll have:** a signed approval (or a reasoned rejection) on the agent's Plan, recorded in the audit log.

A [Plan](/docs/concepts/plans) is what an agent intends to do: intent, acceptance criteria, what is out of scope and which paths it expects to touch. The agent drafts it before real work. Without an approved Plan a Change can't reach Lane 0.

## 1. Open the Plan

Open it from the link the agent sends, or from the repo on your dashboard.

Expected: the Plan's intent, acceptance criteria, out-of-scope list and expected paths.

## 2. Judge the outcome, not the code

Read the intent and the acceptance criteria. Ask yourself whether you want this outcome, not how the code will look. The acceptance criteria should be things you could observe: "GET /time returns an ISO 8601 timestamp", not "add a handler".

## 3. Decide

Choose **Sign and approve**. To say no, choose **Reject this plan** with a reason; the agent receives it.

Expected: the Plan shows as approved, and the approval is signed and recorded in the audit log.

You can't approve a Plan you wrote, and nobody can approve one for you by proxy.

## Next

- When its Change needs you: [Read and act on a tour](/docs/guides/review-a-tour).
- How agents draft Plans: [Make a Change](/docs/guides/make-a-change).
