---
title: Grade pull requests on GitHub
nav: Grade pull requests
description: After the App is installed - say what a pull request is for, link a Plan, review from GitHub or gittifacts, and read the verdict from an agent. Report-only, one check run.
order: 61
audience: humans
group: GitHub
---

# Grade pull requests on GitHub

**You'll have:** pull requests graded with the right category and Plan, and approvals that count from GitHub or gittifacts.

GitHub mode keeps your code on GitHub. The gittifacts App reads each pull request, runs the same evidence as native mode on a disposable mirror, and posts **one** check run, `gittifacts/lane`, on the pull request's head commit. The check run shows the lane as soon as it is computed, while the walkthrough is still being written.

Once someone links the installation, a pull request that needs a human also gets **one summary comment**, edited in place on every push: the lane and why, what a person does, and a link to the walkthrough, with the details folded. That is all gittifacts posts. Report-only mode never approves, blocks or merges.

To see the stops worth a look as comments on the diff (at most three: risks, untested or unproven lines), add the `gittifacts:walkthrough` label to the pull request or press **Request full review** on the check run.

Not installed yet? [Connect GitHub](/docs/get-started/github) takes three steps. Operators register the App once: [Register the GitHub App](/docs/guides/register-github-app).

## 1. Say what the change is

| You add | Effect |
|---|---|
| A label `gittifacts:fix` (or `feature`, `refactor`, `dependency`, `transform`, `revert`, `docs`, `chore`) | The claimed category. A conventional title (`fix: …`, `feat: …`) works too; without either it's graded as a feature |
| A line `gittifacts-plan: <plan id>` in the description | Links a Plan approved on gittifacts, or a plan file `.platform/plans/<id>.md` on the default branch (approve it on gittifacts) |
| `Closes #12`, where issue #12 has the label `gittifacts:plan` | The issue is the Plan. The label counts as approval only from someone with write access who wrote neither the issue nor the pull request |

Without an approved Plan there is no auto-merge. Changing the labels, the title, the description or the issue's label grades the same head again.

## 2. Review

Approve the walkthrough on gittifacts, approve the pull request on GitHub, or press **Approve change** on the check run: it is the same approval. It counts from a human with write access who isn't the author, for the current head. **Request full review** on the check run shows on the summary. GitHub still merges.

Repo owners can turn the summary comment and requested reviews off for one repository on `/settings/github`; the check run stays.

## 3. Read the verdict from an agent

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
| Pull requests: read and write | One summary comment, and the walkthrough's flagged stops as one review when someone asks, once the installation is linked (repo owners can turn them off) |
| Merge queues, deployments, commit statuses: read | `merge_group`, deployment signals and other CI results as extra evidence |

Never requested: administration, workflows, commit statuses (write). Installation tokens are minted per job for one repository and are never given to the sandbox that runs pull request code.

## Troubleshooting

- **"That step expired"** or **"started in another browser"**: open the installation on GitHub (**Configure**) and save, or install again, in the browser you're signed in with. Each step is good for ten minutes, in one browser.
- **"Your GitHub account can't see that installation"**: authorize with the GitHub account that installed the App, or ask an organization owner to link it.
- **No check run after a few minutes**: check that the pull request targets the default branch and isn't a draft. Otherwise ask whoever runs the platform to look at the App's deliveries ([Register the GitHub App](/docs/guides/register-github-app#if-deliveries-fail)).

## Next

- How lanes are chosen and how auto-merge is earned: [Lanes](/docs/concepts/lanes).
- Plans, and why there's no auto-merge without one: [Plans](/docs/concepts/plans).
