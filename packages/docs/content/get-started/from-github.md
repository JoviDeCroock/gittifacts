---
title: Move a repo from GitHub
nav: Move a repo from GitHub
description: Import a public GitHub repo with its history in one command, watch its first CI run, and get the platform's setup proposed as a Plan and a Change. No account needed.
order: 3
audience: both
---

# Move a repo from GitHub

**You'll have:** a GitHub repo on gittifacts with its full history, its first CI run, and a proposed setup for you to approve. No account needed.

You need Node 22 or later, git, and a public GitHub repo. The commands use our sample repo; put your own URL in its place.

## 1. Import the repo

```sh
npx -y https://<host>/cli/gittifacts.tgz --host https://<host> init --from https://github.com/JoviDeCroock/gittifacts-fixture-clock-api --name clock-api --clone
```

Expected, after about 30 seconds: `projectId`, `bootstrapChangeId` and `clonedTo`. The clone has the same history as GitHub: `git -C clock-api log --oneline -1` shows GitHub's latest commit.

<details>
<summary>Private repos, MCP, and where the copy lives</summary>

`--from` takes public `https://` URLs only. A private repo comes in by push: [Import a private repo](/docs/guides/import-a-private-repo).

Agents call the same thing over MCP: `create_project({ from: "https://github.com/acme/clock-api", name: "clock-api" })`. The import copies the repo and its history into an Artifacts repo in the EU jurisdiction. Without an account the repo is unclaimed: it's deleted after 7 days unless a human opens `claimUrl` ([Unclaimed repos](/docs/concepts/unclaimed-projects)).

</details>

## 2. Watch the first CI run

```sh
cd clock-api
alias gittifacts="npx -y https://<host>/cli/gittifacts.tgz"
gittifacts wait bs-8t4xc6kq2w9m0d7z3r1b --until evidence_ready
```

Use your own `bootstrapChangeId`. Until the repo has its own config, CI runs a default pipeline detected from `package.json`.

Expected, within about a minute: `"reached": true`. The sample repo has a test that fails on GitHub too, so its `test` step fails and the Change's status is `failing`. That's what an imported repo looks like when it was red before: the next step says so.

## 3. Get the setup proposal

```sh
gittifacts propose-platform-config 8t4xc6kq2w9m0d7z3r1b --wait-sec 45
```

Use your `projectId`. Detection reads the repo in a sandbox, without installing or running anything: package manager, test runner, build command, TypeScript config, wrangler configs, workspaces.

Expected, in about 30 seconds: `"status": "proposed"` with a `planId`, a `changeId` and what detection found (`packageManager`, `testRunner`, and the guesses it's unsure of under `uncertain`). For the sample repo the Plan says `test` already fails on the default branch: pre-existing, not caused by the Change. The Change adds `.platform/ci.ts`, `.platform/policy.ts` and an `AGENTS.md` section.

<details>
<summary>"not-needed", push imports, and the MCP call</summary>

`status: "not-needed"` means the repo already has its config. After an import by push the platform starts detection by itself; the same call returns that proposal. Over MCP: `propose_platform_config({ repoId: "8t4xc6kq2w9m0d7z3r1b", waitSec: 45 })`. After an import with `from`, the response's `nextSteps` list this call right after the wait for the first CI run.

</details>

## Next

- Approve the proposal, move people and agents, and cut over: [Migrate from GitHub](/docs/guides/migrate-from-github).
- Not ready to move? Grade pull requests on GitHub instead: [Connect GitHub](/docs/get-started/github).
