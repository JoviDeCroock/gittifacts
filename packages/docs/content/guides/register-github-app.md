---
title: Register the GitHub App (operators)
nav: Register the GitHub App
description: For whoever runs the platform, once. Create the gittifacts GitHub App by hand and give its values to the Worker, so people can install it from /settings/github.
order: 62
audience: humans
group: GitHub
---

# Register the GitHub App (operators)

**You'll have:** `/settings/github` offering **Install on GitHub**, and GitHub delivering webhooks to your platform.

This is operator work, done once per platform. There is one gittifacts App per platform, registered by hand and read from the Worker's config; nothing on `/settings/github` creates Apps. Until it's configured, that page says "GitHub mode isn't set up" and lists the missing names.

## 1. Create the App on GitHub

Open **Settings → Developer settings → GitHub Apps → New GitHub App** (for an organization: **Your organizations → Settings** next to it, then the same). Fill in, with `<host>` your platform's origin:

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

Select **Create GitHub App**. Expected: the App's page. Note the **App ID**, the **Client ID** and the slug (the last part of `https://github.com/apps/<slug>`).

## 2. Create its secrets

On the App's page, select **Generate a new client secret**, and under **Private keys** select **Generate a private key**.

Expected: a client secret on screen and a `.pem` file in your downloads.

## 3. Give the values to the Worker

From `apps/platform`:

```sh
pnpm exec wrangler secret put GITHUB_APP_ID            # the App ID
pnpm exec wrangler secret put GITHUB_APP_SLUG          # the slug
pnpm exec wrangler secret put GITHUB_APP_CLIENT_ID     # the Client ID
pnpm exec wrangler secret put GITHUB_APP_CLIENT_SECRET # the client secret
pnpm exec wrangler secret put GITHUB_APP_WEBHOOK_SECRET  # the webhook secret from the form
pnpm exec wrangler secret put GITHUB_APP_PRIVATE_KEY < ~/Downloads/<slug>.<date>.private-key.pem
```

Expected: `/settings/github` shows the App with **Install on GitHub**, and the App's **Advanced** tab on GitHub shows deliveries answered `202`. Delete the downloaded `.pem` once it's set.

<details>
<summary>Vars instead of secrets, and limiting repositories</summary>

The first three values aren't secret: you can put them under `vars` in `wrangler.jsonc` instead (not both).

`GITHUB_REPO_ALLOWLIST` (a var, comma-separated `owner/repo`, case-insensitive) limits GitHub mode to those repositories, whatever an installation covers: nothing outside it is mirrored, graded or commented on. Unset or empty means every repository of an installation.

</details>

## If deliveries fail

- **Answered `503`**: the Worker's App config is incomplete (`/settings/github` names what's missing). Once it's set, the platform asks GitHub to redeliver failures from the last three days on its own.
- **Answered `401`**: the webhook secret on GitHub and `GITHUB_APP_WEBHOOK_SECRET` differ, or the delivery is for another App. To rotate the secret without dropping deliveries, set the old one as `GITHUB_APP_WEBHOOK_SECRET_PREVIOUS`, the new one as `GITHUB_APP_WEBHOOK_SECRET`, change it on GitHub, then delete the previous one.

## Next

- People install it: [Connect GitHub](/docs/get-started/github).
- What the App may do and why: [Grade pull requests on GitHub](/docs/guides/github-mode#what-the-app-may-do).
