---
title: Try it in 2 minutes
nav: Try it in 2 minutes
description: One npx command creates a repo, runs its first CI and starts a preview. Then wait for the green check and open the preview URL. No account needed.
order: 2
audience: both
---

# Try it in 2 minutes

**You'll have:** a new repo cloned on your machine, a green CI check and a live preview URL. No account needed.

You need Node 22 or later and git.

## 1. Create a project

```sh
npx -y https://<host>/cli/gittifacts.tgz --host https://<host> init --template workers-api --name my-api --clone
```

Expected, after about 20 seconds (abbreviated):

```jsonc
{
  "projectId": "3fk2q8wz7m1x0c5v9nbd",
  "previewUrl": "https://p-bs-3fk2q8wz7m1x0c5v9nbd-pv.resynapse.dev",
  "claimUrl": "https://<host>/claim/gtc_…",
  "bootstrapChangeId": "bs-3fk2q8wz7m1x0c5v9nbd",
  "tokenStored": true,
  "clonedTo": "/home/you/my-api"
}
```

The platform made a repo from the `workers-api` template and started its first CI run and a preview.

<details>
<summary>What did that store, and why no login?</summary>

Without a login you get an **unclaimed project**: it works now and is deleted after 7 days unless someone opens `claimUrl` and keeps it ([Unclaimed projects](/docs/concepts/unclaimed-projects)). The CLI stores the project's token in `~/.config/gittifacts/credentials.json` (mode 0600) and writes `.gittifacts.json` (`{ host, projectId, remote }`, no secrets) in the clone. The token reaches git through its environment, never argv or `.git/config`.

The CLI is a thin wrapper over the MCP tools: every tool is a command, and output is one JSON document. Other templates: `preact-app`, `ts-library` (no preview), `static-site`.

</details>

## 2. Wait for the green check

```sh
cd my-api
alias gittifacts="npx -y https://<host>/cli/gittifacts.tgz"
gittifacts wait bs-3fk2q8wz7m1x0c5v9nbd --until evidence_ready
```

Use your own `bootstrapChangeId`. Expected, within about a minute: `"reached": true` and exit code 0.

<details>
<summary>Exit codes and timeouts</summary>

`wait` re-issues the long-poll until the milestone or `--timeout` (default 600 s). Exit code 0 means reached, 3 means it timed out or can no longer be reached (CI failed: step 3 shows the failing step).

</details>

## 3. Open the preview

```sh
gittifacts get-change-status bs-3fk2q8wz7m1x0c5v9nbd --human
```

Expected: the run `passed` with steps `install`, `lint`, `typecheck`, `test`, `build`, and the preview URL. Open it in a browser or with `curl`: `workers-api` answers `{ "now": "…" }`.

That's the loop's first half: code in, proof out. Next, change something.

## Next

- Keep the project and use it under your own name: [Use the CLI](/docs/guides/use-the-cli) (log in, claim, everyday commands).
- Change the code and ship it through review: [Make a Change](/docs/guides/make-a-change).
- What "green" proves: [Evidence](/docs/concepts/evidence).
