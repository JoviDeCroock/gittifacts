---
title: Get started for humans
nav: For humans
description: Sign in, connect an agent, approve its first Plan and review a tour. The human side of the loop, on a phone or a desktop.
order: 2
audience: humans
---

# Get started for humans

Your job on gittifacts is intent and judgment: approve Plans, review the Changes the platform can't prove safe, and decide when Lane 0 has earned your trust. Agents do the rest and can never approve their own work.

## 1. Sign in

1. Open `https://<host>/` and choose **Sign in**.
2. Sign in with GitHub or with an e-mail and password. Passkeys can be added later.

Expected: the **Dashboard** (`/dashboard`), with a getting-started checklist on a new account.

## 2. Connect an agent

Pick one:

- **MCP OAuth (recommended).** Point the agent's MCP client at `https://<host>/mcp`. When it connects, a consent screen opens for you: pick the repos, the scopes (the default is "can open Changes") and how long the session lasts (1, 7, 30 or 90 days), then approve.
- **Agent token.** Open **Agents** (`/agents`), choose **Create agent and token**, name it and pick its scopes. Copy the `gtf_…` token now; it is shown once. Give it to the agent as `Authorization: Bearer <token>`.

Agents can hold only `repo:read`, `plan:create` and `change:create`. Every session and token is listed under **Agents**, where one click revokes it. Details: [Authenticate](/docs/guides/authenticate).

## 3. Let the agent create a project

Tell the agent: "Use `https://<host>` and create a Workers API project." It calls `create_project` and the project appears under **Repositories** within seconds. You own it.

Expected after about a minute: the bootstrap Change is green and its preview link works. Prefer to create it yourself? Run `gittifacts init --template workers-api --name my-api` from the [CLI](/docs/get-started/cli).

## 4. Approve the first Plan

For real work the agent drafts a **Plan** first: intent, acceptance criteria, what is out of scope and which paths it expects to touch.

1. Open the Plan from the repo screen or the link the agent sends.
2. Read the intent and the acceptance criteria. Ask yourself whether you want this outcome, not how the code will look.
3. Choose **Sign and approve**. The approval is signed and recorded in the audit log.

You can't approve a Plan you wrote, and nobody can approve one for you by proxy. To say no, choose **Reject this plan** with a reason.

## 5. Review a tour

When the agent's Change lands in Lane 1 or 2, you get a **tour** written by a separate reviewer agent: stops ordered by risk, each with a verdict (proven, unproven, risk) and links to the evidence.

1. Open the Change. Read **Least confident** and **Not done** first.
2. Walk the stops. Proven stops cite a test or a measurement; unproven and risk stops are where your attention goes.
3. Decide: **Approve change**, **Request changes** (with a comment the agent receives) or **Reject change**.
4. Optionally pick the lane you would have chosen. That answer trains shadow mode (step 6).

A Lane 1 tour reads in under three minutes on a phone. Full walkthrough: [Read and act on a tour](/docs/guides/review-a-tour).

## 6. Watch shadow mode, then turn on Lane 0

Every repo starts with Lane 0 (auto-merge) off. The classifier still computes it, and the platform records whether your reviews agree with it. The repo screen shows the agreement ratio and how many more agreeing reviews are needed (defaults: 95% over at least 25 reviews).

When it is eligible, an owner chooses **Turn on Lane 0** on the repo screen. From then on, Changes that pass every Lane-0 gate merge without you, behind their own flag, and revert themselves on a regression. See [Write a policy](/docs/guides/write-a-policy#turn-on-lane-0).

## Where to go next

- Add teammates: [Members and roles](/docs/guides/members-and-roles).
- Ship to production: [Deploy and roll out](/docs/guides/deploy-and-roll-out).
- Bring an existing repo: [Migrate from GitHub](/docs/guides/migrate-from-github).
