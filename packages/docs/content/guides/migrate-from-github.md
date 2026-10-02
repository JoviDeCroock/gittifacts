---
title: Migrate from GitHub
description: Import a repo with its history, let detection propose the platform config as a Plan and Change, switch remotes, and cut over with a checklist.
order: 13
audience: both
---

# Migrate from GitHub

Import is the on-ramp: your history comes along, standard git clients keep working, and the platform proposes its own configuration as a Change a human approves. Nothing is applied silently.

## 1. Import the repo

```text
create_project({ from: "https://github.com/acme/clock-api", name: "clock-api" })
```

```sh
gittifacts init --from https://github.com/acme/clock-api --name clock-api
```

Expected: `projectId`, a bootstrap Change running CI with a default pipeline, and a push grant for your first Change. The import copies the repo and its history into an Artifacts repo in the EU jurisdiction. Public `https://` URLs only; **Coming soon:** private GitHub repos.

## 2. Check the history

```sh
git -c http.extraHeader="Authorization: Bearer $GITTIFACTS_TOKEN" clone "https://<host>/git/<owner>/clock-api.git"
cd clock-api && git log --oneline | wc -l
```

Expected: the same commit count and head as on GitHub (`git ls-remote https://github.com/acme/clock-api HEAD`).

## 3. Let detection propose the platform config

```text
propose_platform_config({ repoId: "8t4xc6kq2w9m0d7z3r1b", waitSec: 45 })
```

Detection reads the repo in a sandbox (nothing is installed or run): package manager, test runner, build command, TypeScript config, wrangler configs, workspaces. Expected: `status: "proposed"` with a `planId` and a `changeId`:

- the **Plan** (drafted by `system`) lists every guess it isn't sure of as a risk, starting "Detection is unsure: …";
- the **Change** adds `.platform/ci.ts`, `.platform/policy.ts` and an `AGENTS.md` section. It is Lane 2 because it touches `.platform/**`.

A human approves the Plan, reviews the Change and approves it; the merge queue lands it. Until then CI uses a default pipeline detected from `package.json` and the default policy. `status: "not-needed"` means the repo already has its config.

## 4. Point people and agents at gittifacts

| Before (GitHub) | After |
|---|---|
| `git clone git@github.com:acme/clock-api` | `https://<host>/git/<owner>/clock-api.git` with an agent token (read-only) |
| Push a branch, open a PR | `start_change`, push to the Change's fork ([Commit and push with git](/docs/guides/git)) |
| PR review | Plan approval up front, then a tour for Lanes 1 and 2 |
| GitHub Actions | `.platform/ci.ts` ([Configure CI](/docs/guides/configure-ci)); there is no Actions compatibility layer |
| Branch protection | Only the merge queue writes the default branch, always |
| Deploy hooks | An integration ([Connect a deploy platform](/docs/guides/connect-a-deploy-platform)) or a deploy target |

## 5. Bring over late commits

Commits made on GitHub after the import don't sync. Carry them as one Change:

```sh
git remote add github https://github.com/acme/clock-api
git fetch github main
git checkout -b catch-up github/main
git push "$PUSH_URL" HEAD:refs/heads/main
```

Use the push grant of a Change you started for it (`category: "chore"`). The merge queue rebases it onto the imported main.

## Cut-over checklist

- [ ] History and head match GitHub (step 2).
- [ ] The `.platform` proposal is approved and merged; the default branch is green.
- [ ] `sensitivePaths` in the policy cover your auth, payments and migration code ([Write a policy](/docs/guides/write-a-policy)).
- [ ] Members added with the right roles ([Members and roles](/docs/guides/members-and-roles)).
- [ ] Agents connected with OAuth sessions limited to this repo ([Authenticate](/docs/guides/authenticate)).
- [ ] A deploy integration or deploy target set; a preview deployment seen on a test Change.
- [ ] GitHub Actions secrets moved to your deploy platform (CI steps never get secrets).
- [ ] A last catch-up Change merged (step 5), then the GitHub repo set to read-only or archived.
- [ ] Old remotes removed from local clones: `git remote remove origin`.

**Coming soon:** an optional mirror that pushes the default branch back to GitHub, for teams mid-migration.
