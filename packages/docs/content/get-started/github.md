---
title: Connect GitHub
description: Keep your code on GitHub. Install the gittifacts App on a repository, open a pull request, and see its review lane as one check run, in shadow mode.
order: 4
audience: humans
---

# Connect GitHub

**You'll have:** a pull request on GitHub with a `gittifacts/lane` check that says how much review it needs. Nothing else on GitHub changes: shadow mode never approves, blocks or merges.

You need a gittifacts account (sign in at `https://<host>/dashboard`) and admin rights on a GitHub organization or repository.

## 1. Install the App

Open `https://<host>/settings/github` and select **Install on GitHub**. On GitHub, pick the organization, choose **Only select repositories**, pick one or two, and select **Install**.

Expected: GitHub sends you back and asks you to authorize gittifacts. That proves the installation is yours. Then `/settings/github` lists the installation with its repositories.

<details>
<summary>The page says "GitHub mode isn't set up"</summary>

Each platform has one gittifacts App, registered by whoever runs the platform and read from the Worker's config. Until it's configured, `/settings/github` lists the missing names. The operator follows [Register the GitHub App](/docs/guides/register-github-app). An operator can also limit GitHub mode to some repositories; the others are never graded.

</details>

## 2. Open a pull request

Push a branch and open a pull request against the default branch of an installed repository.

Expected: within about two minutes, the pull request's **Checks** tab shows `gittifacts/lane (shadow)`:

| Conclusion | Lane | Means |
|---|---|---|
| `success` | 0 | could merge without a human (shadow mode merges nothing) |
| `neutral` | 1 | a quick look, with a guided tour |
| `action_required` | 2 | a full review |

## 3. Read why

The check's title names the lane and the one reason that decided it, for example `Full review (Lane 2) · public API changed`. Open it for what a person does next and a link to the Change on gittifacts; every reason and the evidence are folded below.

Expected: reasons such as `plan.missing` (no approved Plan, so no Lane 0) or `sensitive.hit` (a sensitive path changed). [Lane reasons](/docs/reference/lane-reasons) explains each one. Policy always comes from the default branch, never from the pull request.

<details>
<summary>Which pull requests are graded</summary>

Open pull requests against the default branch, not drafts (they're graded when marked ready). Each new head is graded again; a head replaced before its verdict shows as cancelled. The lane shows on the check while the walkthrough is still being written. Once someone links the installation, a pull request that needs a human also gets one summary comment, edited in place, and at most three stops on the diff as one review.

</details>

## Next

- Tell the platform what a pull request is for, link Plans, review from GitHub: [Grade pull requests on GitHub](/docs/guides/github-mode).
- How lanes are chosen: [Lanes](/docs/concepts/lanes).
- Ready to move the repo itself: [Move a repo from GitHub](/docs/get-started/from-github).
