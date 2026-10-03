---
title: Grade pull requests on GitHub
description: Install the gittifacts GitHub App on an organization and get a lane on every pull request in shadow mode - one check run, nothing else changes.
order: 13
audience: humans
---

# Grade pull requests on GitHub

GitHub mode keeps your code on GitHub. The gittifacts App reads each pull request, runs the same evidence as native mode on a disposable mirror, and posts **one** check run, `gittifacts/lane`, on the pull request's head commit. Once someone links the installation, a pull request that needs a human also gets the tour as **one review** (one comment per stop) and **one summary comment** that is edited in place. Shadow mode never approves, blocks or merges.

## 1. Create the App (platform admins, once)

Open `https://<host>/settings/github` signed in as a platform admin.

1. Pick the owner: an organization you own, or your own GitHub account.
2. Keep the name `gittifacts`, or pick another. App names are unique across GitHub (34 characters at most).
3. Select **Continue on GitHub**. GitHub shows the App it's about to create; select **Create GitHub App**.

Expected: you're back on `/settings/github` with "GitHub created …". The App's keys never pass through your hands: GitHub hands them to the platform, which stores them encrypted. The link is good for one hour and works once.

## 2. Install it

Select **Install on GitHub**, pick the organization and **Only select repositories**, choose one or two, and select **Install**.

Expected: GitHub sends you back, asks you to authorize gittifacts (this proves the installation is yours; we never trust the installation id alone), then `/settings/github` lists the installation with its repositories.

## 3. Open a pull request

Push a branch and open a pull request in an installed repository.

Expected: within about two minutes the **Checks** tab shows `gittifacts/lane (shadow)`:

| Conclusion | Means |
|---|---|
| `success` | Lane 0: eligible to merge without a human (shadow mode merges nothing) |
| `neutral` | Lane 1: a quick look with a guided tour |
| `action_required` | Lane 2: full review |

The summary lists the reasons and the evidence, and links to the change on gittifacts. Policy always comes from the repository's default branch, never from the pull request.

What is graded: open pull requests against the default branch, not drafts (they're graded when marked ready). Each new head is graded again; a head replaced before its verdict shows as cancelled.

## 4. Say what the change is (optional)

| You add | Effect |
|---|---|
| A label `gittifacts:fix` (or `feature`, `refactor`, `dependency`, `transform`, `revert`, `docs`, `chore`) | The claimed category. A conventional title (`fix: …`, `feat: …`) works too; without either it's graded as a feature |
| A line `gittifacts-plan: <plan id>` in the description | Links a Plan approved on gittifacts, or a plan file `.platform/plans/<id>.md` on the default branch (approve it on gittifacts) |
| `Closes #12`, where issue #12 has the label `gittifacts:plan` | The issue is the Plan. The label counts as approval only from someone with write access who wrote neither the issue nor the pull request |

Without an approved Plan there is no Lane 0. Changing the labels, the title, the description or the issue's label grades the same head again.

## 5. Review

Approve the tour on gittifacts, approve the pull request on GitHub, or press **Approve tour** on the check run: it is the same approval. It counts from a human with write access who isn't the author, for the current head. **Request full review** on the check run shows on the summary. GitHub still merges.

Repo owners can turn the review and summary comment off for one repository on `/settings/github`; the check run stays.

## 6. From an agent

```text
get_change_status({ github: "acme/widgets#7" })
wait_for_change({ github: "acme/widgets#7", until: "lane_assigned" })
```

```sh
gittifacts get-change-status --github acme/widgets#7
```

Expected: the Change that grades the pull request, with its lane and reasons. The installation's linked humans (and their agents) can read it; anyone else gets not-found.

## What the App may do

| Permission | Why |
|---|---|
| Metadata, contents, issues: read | Read the code (fork pull requests too, through `pull/<n>/head`) and linked issues |
| Checks: write | Post `gittifacts/lane` |
| Pull requests: write | Tours as one review, from milestone M3. Shadow mode posts none |
| Merge queues, deployments, commit statuses: read | `merge_group`, deployment signals and other CI results as extra evidence |

Never requested: administration, workflows, commit statuses (write). Installation tokens are minted per job for one repository and are never given to the sandbox that runs pull request code.

## Troubleshooting

- **"That step expired or was already used"**: start again from `/settings/github`. Each step works once, within an hour.
- **"Your GitHub account can't see that installation"**: authorize with the GitHub account that installed the App, or ask an organization owner to link it.
- **A failed `ping` delivery** in the App's **Advanced** tab right after creating it is expected: GitHub pings before the platform has stored the App's keys.
