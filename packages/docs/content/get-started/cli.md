---
title: Try it in 2 minutes
nav: Try it in 2 minutes
description: One npx command creates a repo, runs its first CI and starts a preview. Wait for the green check, edit a file, and ship it to a review lane with plain git. No account needed.
order: 2
audience: both
---

# Try it in 2 minutes

**You'll have:** a new repo cloned on your machine, a green CI check, a live preview URL and your first edit in a review lane. No account needed.

You need Node 22 or later and git.

## 1. Create a repo

```sh
npx -y https://<host>/cli/v2/gittifacts.tgz --host https://<host> init --template workers-api --name my-api --clone
```

Expected, after about 20 seconds:

```text
Created repo my-api (3fk2q8wz7m1x0c5v9nbd)
Preview: https://p-bs-3fk2q8wz7m1x0c5v9nbd-pv.resynapse.dev (live once the first CI run is green)
Claim it to keep it (unclaimed repos expire): https://<host>/claim/gtc_…
Cloned into my-api. Next: edit a file, commit, then ship it:
  $ cd my-api && git commit -am "<what changed>" && gittifacts ship
  (no gittifacts on PATH? alias gittifacts="npx -y https://<host>/cli/v2/gittifacts.tgz")
```

The platform made a repo from the `workers-api` template and started its first CI run and a preview.

<details>
<summary>What did that store, and why no login?</summary>

Without a login you get an **unclaimed repo**: it works now and is deleted after 7 days unless someone opens the claim link and keeps it ([Unclaimed repos](/docs/concepts/unclaimed-projects)). The CLI stores the repo's token in `~/.config/gittifacts/credentials.json` (mode 0600) and writes `.gittifacts.json` (`{ host, projectId, changeId, remote }`, no secrets, git-ignored) in the clone. It points `origin` at your first Change's fork and installs `gittifacts git-credential` as git's credential helper there, so `git push` gets a fresh push token each time. No token lands in argv or `.git/config`.

The CLI is a thin wrapper over the MCP tools: every tool is a command. On a terminal it prints text; piped, or with `--json`, it prints one JSON document (agents read that). Other templates: `preact-app`, `ts-library` (no preview), `static-site`.

Without an account, each network address can create 3 repos an hour. Past that, `init` answers `rate-limited` and says how many seconds to wait; `--idempotency-key` with the printed key retries the same request.

</details>

## 2. Wait for the green check

```sh
cd my-api
alias gittifacts="npx -y https://<host>/cli/v2/gittifacts.tgz"
gittifacts wait bs-3fk2q8wz7m1x0c5v9nbd --until evidence_ready
```

The first CI run's Change is `bs-` and your repo id (the first line `init` printed). Expected, within about a minute: `reached` and exit code 0.

<details>
<summary>Exit codes and timeouts</summary>

`wait` re-issues the long-poll until the milestone or `--timeout` (default 600 s). Exit code 0 means reached, 3 means it timed out or can no longer be reached (CI failed: step 3 shows the failing step).

</details>

## 3. Open the preview

```sh
gittifacts get-change-status bs-3fk2q8wz7m1x0c5v9nbd
```

Expected: the run `passed` with steps `install`, `lint`, `typecheck`, `test`, `build`, and the preview URL. Open it: `workers-api` answers `{ "now": "…" }`.

## 4. Change something and ship it

```sh
sed -i.bak 's/now:/time:/' src/index.ts && rm src/index.ts.bak
git commit -am "Rename now to time"
gittifacts ship
```

`ship` pushes your commit to the Change's fork (plain `git push` works too), waits for CI and the lane, and prints what decided it. Expected, within a couple of minutes:

```text
Shipped 7h2kd9x0qw3m5z8r1vtc: pushed 3c9e1f0a2b4d
Lane: Quick review (Lane 1)
  - No plan is attached to this change. (plan.missing)
  12 checks passed
Change: https://<host>/changes/7h2kd9x0qw3m5z8r1vtc
Next: Ask a person to review it
  $ gittifacts request-review 7h2kd9x0qw3m5z8r1vtc
```

<details>
<summary>CI failed, or the lane says Auto-merge</summary>

When a step fails, `ship` names it and exits 3: fix it, commit, and `gittifacts ship` again (the same Change takes the new head). Auto-merge (Lane 0) needs no review: the merge queue lands it. Once a Change has merged, the next `ship` starts a new one and points `origin` at its fork. Piped, `ship` prints one JSON document with the same fields.

</details>

## 5. Ask for a review

```sh
gittifacts request-review 7h2kd9x0qw3m5z8r1vtc
```

A person opens the Change page, reads the walkthrough and approves; the merge queue lands it on `main`. The whole loop, with a Plan first: [Your first merge](/docs/get-started/first-merge).

## Next

- Keep the repo and use it under your own name: [Use the CLI](/docs/guides/use-the-cli) (log in, claim, `gittifacts clone`).
- Change the code through a Plan: [Make a Change](/docs/guides/make-a-change).
- What "green" proves: [Evidence](/docs/concepts/evidence).
