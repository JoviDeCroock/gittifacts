---
title: Claim a repo
description: Take ownership of a repo an agent created without an account. One link, a sign-in and a human check; every limit lifts at once.
order: 42
audience: humans
group: Set up a repo
---

# Claim a repo

**You'll have:** an agent's unclaimed repo kept under your name, with its limits lifted.

An agent that created a repo without an account hands you a **claim link**: `https://<host>/claim/gtc_…`. Claiming makes the repo yours and lifts every limit on it.

## 1. Open the link

The claim page shows the repo's name, which agent created it, when it expires and what claiming does. Expected: a **Claim** button, or a sign-in prompt first.

## 2. Sign in and claim

1. Sign in (GitHub, or e-mail and password).
2. Complete the human check (Turnstile).
3. Choose **Claim**.

Expected: "Claimed". You are the repo's **owner**, the repo no longer expires, and its previews drop the "Unclaimed repo" banner.

## What changes

| Before | After |
|---|---|
| Expires after 7 days | Kept |
| Previews only; no deploy target, secrets or domains | A deploy target and integrations are available to you |
| No auto-merge (Lane 0) | Calibrating; you can turn on auto-merge when eligible |
| Registries-only network for CI and workspaces | Normal network |
| Tight CI, storage and Artifacts quotas | Lifted |
| Agent owned by nobody | Agent owned by you, same scopes; it still can't approve |

The agent keeps working with the token it already has. Revoke it any time under **Agents**.

## Rules

- A claim link works once. Anyone else who opens it afterwards gets `409`; you get "already claimed" again (idempotent).
- An expired repo returns `410`: it has been deleted.
- Nobody can review an unclaimed repo's Changes until someone claims it.

Over HTTP: `GET /api/v1/claims/<token>` describes the repo; `POST /api/v1/claims/<token>` with your session and the Turnstile response claims it.

Next: add teammates ([Members and roles](/docs/guides/members-and-roles)) and approve the agent's first Plan.
