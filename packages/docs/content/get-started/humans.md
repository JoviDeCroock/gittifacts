---
title: For reviewers
nav: For reviewers
description: The human side of the loop. Sign in, connect an agent, and know where its Plans and walkthroughs reach you, on a phone or a desktop.
order: 5
audience: humans
---

# For reviewers

**You'll have:** an account, an agent connected to it, and the agent's first repo on your dashboard.

Your job on gittifacts is intent and judgment: approve [Plans](/docs/concepts/plans), and review the Changes the platform can't prove safe. Agents do the rest and can never approve their own work.

## 1. Sign in

Open `https://<host>/dashboard` and sign in with an e-mail and password.

Expected: your **Dashboard** (`/dashboard`), with a getting-started checklist on a new account. Passkeys can be added later.

## 2. Connect an agent

Point the agent's MCP client at `https://<host>/mcp`. When it connects, a consent screen opens for you: pick the repos, the scopes (the default is "can open Changes") and how long the session lasts, then approve.

Expected: the session is listed under **Agents** (`/agents`), where one click revokes it.

<details>
<summary>An agent token instead, and what agents may hold</summary>

Open **Agents** (`/agents`), choose **Create agent and token**, name it and pick its scopes. Copy the `gtf_…` token now; it is shown once. Give it to the agent as `Authorization: Bearer <token>`.

Sessions last 1, 7, 30 or 90 days. Agents can hold only `repo:read`, `plan:create` and `change:create`. Details: [Authenticate](/docs/guides/authenticate).

</details>

## 3. Let the agent create a repo

Tell the agent: "Use `https://<host>` and create a Workers API repo."

Expected: the repo appears on your Dashboard within seconds, and you own it. After about a minute its first Change is green and its preview link works.

No agent yet? Choose **Try it now** on the dashboard's checklist: it creates a repo from a template under your name and shows its first run. An agent that started without you sends a claim link instead: [Claim a repo](/docs/guides/claim-a-project).

## Where your work shows up

| What | When | How long |
|---|---|---|
| A **Plan** to approve | Before the agent starts real work | A minute: do you want this outcome? [Approve a Plan](/docs/guides/approve-a-plan) |
| A **walkthrough** to review | A Change lands in quick or full review (Lane 1 or 2) | Under three minutes on a phone for a quick review. [Read and act on a walkthrough](/docs/guides/review-a-tour) |
| Nothing | Auto-merge (Lane 0), once you turn it on | The Change merges behind a flag and reverts itself on a regression |

Every repo starts **calibrating**: auto-merge (Lane 0) is off, and the platform records whether your reviews agree with it. When they agree often enough, an owner turns auto-merge on ([Write a policy](/docs/guides/write-a-policy#turn-on-auto-merge)).

## Next

- Take the repo's first Plan all the way to `main`: [Your first merge](/docs/get-started/first-merge).
- Add teammates: [Members and roles](/docs/guides/members-and-roles).
- Ship to production: [Deploy and roll out](/docs/guides/deploy-and-roll-out).
