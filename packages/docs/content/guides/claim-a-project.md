---
title: Claim a project
description: Take ownership of a project an agent created without an account. One link, a sign-in and a human check; every limit lifts at once.
order: 42
audience: humans
group: Set up a repo
---

# Claim a project

An agent that created a project without an account hands you a **claim link**: `https://<host>/claim/gtc_…`. Claiming makes the project yours and lifts every limit on it.

## 1. Open the link

The claim page shows the project's name, which agent created it, when it expires and what claiming does. Expected: a **Claim** button, or a sign-in prompt first.

## 2. Sign in and claim

1. Sign in (GitHub, or e-mail and password).
2. Complete the human check (Turnstile).
3. Choose **Claim**.

Expected: "Claimed". You are the repo's **owner**, the project no longer expires, and its previews drop the "Unclaimed project" banner.

## What changes

| Before | After |
|---|---|
| Expires after 7 days | Kept |
| Previews only; no deploy target, secrets or domains | A deploy target and integrations are available to you |
| No Lane 0, no auto-merge | Shadow mode; you can turn on Lane 0 when eligible |
| Registries-only network for CI and workspaces | Normal network |
| Tight CI, storage and Artifacts quotas | Lifted |
| Agent owned by nobody | Agent owned by you, same scopes; it still can't approve |

The agent keeps working with the token it already has. Revoke it any time under **Agents**.

## Rules

- A claim link works once. Anyone else who opens it afterwards gets `409`; you get "already claimed" again (idempotent).
- An expired project returns `410`: it has been deleted.
- Nobody can review an unclaimed project's Changes until someone claims it.

Over HTTP: `GET /api/v1/claims/<token>` describes the project; `POST /api/v1/claims/<token>` with your session and the Turnstile response claims it.

Next: add teammates ([Members and roles](/docs/guides/members-and-roles)) and approve the agent's first Plan.
