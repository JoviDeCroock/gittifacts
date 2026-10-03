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

Expected: `projectId`, a bootstrap Change running CI with a default pipeline, and a push grant for your first Change. The import copies the repo and its history into an Artifacts repo in the EU jurisdiction. `from` takes public `https://` URLs only; for a private repo, push it (below).

### Private repos: import by push

A human owner creates an empty project and pushes the history once. Signed in (your browser session; agents can't do this step):

```sh
curl -X POST "https://<host>/api/v1/projects" -b cookies.txt -H "content-type: application/json" \
  --data '{ "name": "clock-api", "importMode": "push" }'
```

Expected: `projectId` and an `importGrant` with `url`, `token`, `expiresAt` and a `command`. The token writes the project's main repo, so treat it like a password: put it in an environment variable, never in the remote URL or git config, and push the whole default branch in **one** push:

```sh
export GITTIFACTS_IMPORT_TOKEN='<importGrant.token>'
git -c http.extraHeader="Authorization: Bearer $GITTIFACTS_IMPORT_TOKEN" -c http.postBuffer=524288000 \
  push "<importGrant.url>" main:refs/heads/main --follow-tags
```

`http.postBuffer` matters: Artifacts refuses chunked uploads, and git sends any push over 1 MiB chunked unless the buffer is larger. Without it a real history fails with `the remote end hung up unexpectedly` (HTTP 400), and the grant stays open, so you can retry.

The grant closes at the first of: the first push to the repo, the first Change, or 30 minutes. Closing revokes the token. From then on only the merge queue writes the default branch. This is the one exception to that rule: an empty repo, its human owner, before any Change, and both the opening and the closing are in the audit log (`project.import-push-opened`, `project.import-push-closed`).

Check it closed, then go to step 3: detection starts by itself after a push import.

```sh
curl -b cookies.txt "https://<host>/api/v1/repos/<projectId>/import-grant"
```

Expected: `status: "closed"`, `closeReason: "pushed"`, `imported: true` and `mainSha` equal to your local `git rev-parse main`. If the push failed or the grant expired first, `imported` is `false` and the owner can open a new grant (`POST /api/v1/repos/<projectId>/import-grant`) as long as the default branch doesn't exist.

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

After an import by push the platform has already started it; the same call returns that proposal. After an import with `from` (`create_project` with a GitHub URL, or `gittifacts init --from <url>`) nothing starts by itself: the response's `nextSteps` list this call right after the wait for the first CI run.

Detection reads the repo in a sandbox (nothing is installed or run): package manager, test runner, build command, TypeScript config, wrangler configs, workspaces. Expected: `status: "proposed"` with a `planId` and a `changeId`:

- the **Plan** (drafted by `system`) lists every guess it isn't sure of as a risk, starting "Detection is unsure: …". Its acceptance criteria only promise a green CI run when the default branch is green; a step that already fails on the default branch (a red test you imported) is named as pre-existing;
- the **Change** adds `.platform/ci.ts`, `.platform/policy.ts` and an `AGENTS.md` section. It is Lane 2 because it touches `.platform/**`.

**Install scripts (pnpm 11).** pnpm 11 fails the install (`ERR_PNPM_IGNORED_BUILDS`) while a dependency's install script is neither allowed nor denied in `pnpm-workspace.yaml` `allowBuilds`. When detection finds such dependencies, the Change also lists them as `false` there, so CI installs without running their scripts; it never sets one to `true`. If a test or the build needs one of them to run (a native module, a downloaded binary), set it to `true` in the Change before you approve it. Packages that only install on other platforms (`fsevents`, `os: [darwin]` in the lockfile) never install on the Linux runners and are not listed.

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
