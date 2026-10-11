---
title: Your first merge
nav: Your first merge
description: The whole loop on day one. A person approves a small Plan, an agent builds it, the platform signs the evidence and picks a review lane, the person approves, and the merge queue lands it.
order: 6
audience: both
---

# Your first merge

**You'll have:** a Change on your repo's `main`, built by an agent from a Plan you approved, with signed evidence and a signed note on why it exists. Most people get there in a few minutes.

Every repo made from a template comes with a small first Plan, drafted by the platform. For `workers-api` it is **Add GET /version**. Nobody has approved it: not the platform, not the agent.

## 1. Create a repo

On the dashboard's **Get started** checklist, pick a template and choose **Create repo**. An agent can do the same with `create_project({ template: "workers-api" })`.

Expected: the repo is on your dashboard, and the checklist links its Plan. An agent finds the Plan's id in `samplePlanId` and in `nextSteps`.

<details>
<summary>An agent made the repo without you</summary>

It sends you a claim link. Open it and claim the repo first: nobody approves anything in a repo until a person claims it. [Claim a repo](/docs/guides/claim-a-project)

</details>

## 2. Approve the Plan

Open the Plan from the checklist, read what it will change and how to tell it worked, then sign and approve it.

Expected: the Plan shows **Approved** with your name, and the checklist gives you a prompt for your agent.

## 3. Have your agent build it

Paste the prompt into your agent:

```text
Use https://<host>/start. In repo <repoId>, build plan <planId>.
```

The agent starts a Change on the Plan, pushes code and a test, and waits:

```text
start_change({ repoId: "<repoId>", planId: "<planId>", title: "Add GET /version", category: "feature" })
wait_for_change({ changeId: "<changeId>", until: "lane_assigned", timeoutSec: 50 })
request_review({ changeId: "<changeId>" })
```

Expected: CI passes, the evidence is signed, and the Change gets a lane. A new repo is calibrating, so a person reviews it.

## 4. Review and approve the Change

Choose **Review the Change** on the checklist. Read the walkthrough (riskiest part first) and approve.

Expected: the merge queue tests it on `main` and lands it. The checklist's last step shows the time from creating the repo to this merge.

<details>
<summary>Check the merge from a plain clone</summary>

Each landed commit carries a signed note in `refs/notes/why`: the Plan, who approved it, who wrote the Change and who answers for it.

```sh
git fetch origin 'refs/notes/why:refs/notes/why'
git log --notes=why -1 origin/main
```

</details>

## Next

- Plan your own change: [Make a Change](/docs/guides/make-a-change).
- Let a proven Change merge without you: [Lanes](/docs/concepts/lanes#calibrating).
- Add a teammate who approves Plans with you: [Members and roles](/docs/guides/members-and-roles).
