---
title: Grade pull requests on GitHub
description: Register the platform's GitHub App once, install it on an organization, and get a lane on every pull request in shadow mode - one check run, nothing else changes.
order: 13
audience: humans
---

# Grade pull requests on GitHub

GitHub mode keeps your code on GitHub. The gittifacts App reads each pull request, runs the same evidence as native mode on a disposable mirror, and posts **one** check run, `gittifacts/lane`, on the pull request's head commit. Once someone links the installation, a pull request that needs a human also gets the tour as **one review** (one comment per stop) and **one summary comment** that is edited in place. Shadow mode never approves, blocks or merges.

## 1. Register the App (whoever runs the platform, once)

There is one gittifacts App per platform, registered by hand and read from the Worker's config. Nothing on `/settings/github` creates Apps. Until it's configured, that page says "GitHub mode isn't set up" and lists the missing names.

On GitHub, open **Settings → Developer settings → GitHub Apps → New GitHub App** (for an organization: **Your organizations → Settings** next to it, then the same). Fill in, with `<host>` your platform's origin:

| Field | Value |
|---|---|
| GitHub App name | `gittifacts` or any free name (34 characters at most) |
| Homepage URL | `https://<host>` |
| Callback URL | `https://<host>/github/oauth/callback` |
| Expire user authorization tokens | either (the platform revokes the token right after use) |
| Request user authorization (OAuth) during installation | **off** (when on, GitHub ignores the Setup URL) |
| Enable Device Flow | off |
| Setup URL | `https://<host>/github/setup` |
| Redirect on update | **on** |
| Webhook: Active | on |
| Webhook URL | `https://<host>/github/webhooks` |
| Webhook secret | a random value, for example from `openssl rand -hex 32`; keep it for the next step |
| SSL verification | enabled |
| Repository permissions | Metadata: read · Contents: read · Pull requests: read and write · Checks: read and write · Issues: read · Merge queues: read · Deployments: read · Commit statuses: read. Everything else: no access |
| Subscribe to events | Pull request · Pull request review · Check run · Check suite · Issues · Push · Merge group · Deployment status · Status |
| Where can this GitHub App be installed? | **Any account** |

Select **Create GitHub App**. On the App's page, note the **App ID**, the **Client ID** and the slug (the last part of `https://github.com/apps/<slug>`), select **Generate a new client secret**, and under **Private keys** select **Generate a private key** (a `.pem` file downloads).

Then set six values on the Worker (from `apps/platform`):

```sh
pnpm exec wrangler secret put GITHUB_APP_ID            # the App ID
pnpm exec wrangler secret put GITHUB_APP_SLUG          # the slug
pnpm exec wrangler secret put GITHUB_APP_CLIENT_ID     # the Client ID
pnpm exec wrangler secret put GITHUB_APP_CLIENT_SECRET # the client secret
pnpm exec wrangler secret put GITHUB_APP_WEBHOOK_SECRET  # the webhook secret from the form
pnpm exec wrangler secret put GITHUB_APP_PRIVATE_KEY < ~/Downloads/<slug>.<date>.private-key.pem
```

The first three aren't secret: you can put them under `vars` in `wrangler.jsonc` instead (not both). Expected: `/settings/github` shows the App with **Install on GitHub**, and the App's **Advanced** tab shows deliveries answered `202`. Delete the downloaded `.pem` once it's set.

## 2. Install it

On `/settings/github`, select **Install on GitHub** (or open `https://github.com/apps/<slug>/installations/new`), pick the organization and **Only select repositories**, choose one or two, and select **Install**.

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
| Pull requests: read and write | The tour as one review and one summary comment, once the installation is linked (repo owners can turn them off) |
| Merge queues, deployments, commit statuses: read | `merge_group`, deployment signals and other CI results as extra evidence |

Never requested: administration, workflows, commit statuses (write). Installation tokens are minted per job for one repository and are never given to the sandbox that runs pull request code.

## Troubleshooting

- **"That step expired"** or **"started in another browser"**: open the installation on GitHub (**Configure**) and save, or install again, in the browser you're signed in with. Each step is good for ten minutes, in one browser.
- **"Your GitHub account can't see that installation"**: authorize with the GitHub account that installed the App, or ask an organization owner to link it.
- **Deliveries answered `503`** in the App's **Advanced** tab: the Worker's App config is incomplete (`/settings/github` names what's missing). Once it's set, the platform asks GitHub to redeliver failures from the last three days on its own.
- **Deliveries answered `401`**: the webhook secret on GitHub and `GITHUB_APP_WEBHOOK_SECRET` differ, or the delivery is for another App. To rotate the secret without dropping deliveries, set the old one as `GITHUB_APP_WEBHOOK_SECRET_PREVIOUS`, the new one as `GITHUB_APP_WEBHOOK_SECRET`, change it on GitHub, then delete the previous one.
