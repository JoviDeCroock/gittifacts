---
title: Migrate from GitHub
nav: Cut over from GitHub
description: After the import - approve the proposed platform config, point people and agents at gittifacts, bring over late commits, and cut over with a checklist.
order: 44
audience: both
group: Set up a repo
---

# Migrate from GitHub

**You'll have:** gittifacts as the repo's home: config merged, people and agents moved, GitHub read-only.

Start with the import: [Move a repo from GitHub](/docs/get-started/from-github) (public) or [Import a private repo](/docs/guides/import-a-private-repo). Your history comes along, standard git clients keep working, and nothing is applied silently.

## 1. Approve the proposed config

Detection's proposal is a **Plan** (drafted by `system`) and a **Change** that adds `.platform/ci.ts`, `.platform/policy.ts` and an `AGENTS.md` section.

1. Read the Plan's risks. Each guess detection isn't sure of starts "Detection is unsure: …".
2. Approve the Plan, then review the Change. It is Lane 2 because it touches `.platform/**`.
3. Approve the Change. The merge queue lands it.

Expected: the default branch has `.platform/ci.ts` and its CI run uses it. Until then CI uses a default pipeline detected from `package.json`, and the default policy.

<details>
<summary>A step that was already red, and install scripts (pnpm 11)</summary>

The Plan's acceptance criteria only promise a green CI run when the default branch is green. A step that already fails on the default branch (a red test you imported) is named as pre-existing.

pnpm 11 fails the install (`ERR_PNPM_IGNORED_BUILDS`) while a dependency's install script is neither allowed nor denied in `pnpm-workspace.yaml` `allowBuilds`. When detection finds such dependencies, the Change also lists them as `false` there, so CI installs without running their scripts; it never sets one to `true`. If a test or the build needs one of them to run (a native module, a downloaded binary), set it to `true` in the Change before you approve it. Packages that only install on other platforms (`fsevents`, `os: [darwin]` in the lockfile) never install on the Linux runners and are not listed.

</details>

## 2. Point people and agents at gittifacts

| Before (GitHub) | After |
|---|---|
| `git clone git@github.com:acme/clock-api` | `https://<host>/git/<owner>/clock-api.git` with an agent token (read-only) |
| Push a branch, open a PR | `start_change`, push to the Change's fork ([Commit and push with git](/docs/guides/git)) |
| PR review | Plan approval up front, then a tour for Lanes 1 and 2 |
| GitHub Actions | `.platform/ci.ts` ([Configure CI](/docs/guides/configure-ci)); there is no Actions compatibility layer |
| Branch protection | Only the merge queue writes the default branch, always |
| Deploy hooks | An integration ([Connect a deploy platform](/docs/guides/connect-a-deploy-platform)) or a deploy target |

`<owner>` is the project's owner on gittifacts; [Commit and push with git](/docs/guides/git) shows how to clone with a token.

## 3. Bring over late commits

Commits made on GitHub after the import don't sync. Start a Change for them (`category: "chore"`), then push GitHub's main to its fork:

```sh
git remote add github https://github.com/acme/clock-api
git fetch github main
git checkout -b catch-up github/main
git push "$PUSH_URL" HEAD:refs/heads/main
```

Expected: the Change runs CI. The merge queue rebases it onto the imported main.

## Cut-over checklist

- [ ] History and head match GitHub.
- [ ] The `.platform` proposal is approved and merged; the default branch is green.
- [ ] `sensitivePaths` in the policy cover your auth, payments and migration code ([Write a policy](/docs/guides/write-a-policy)).
- [ ] Members added with the right roles ([Members and roles](/docs/guides/members-and-roles)).
- [ ] Agents connected with OAuth sessions limited to this repo ([Authenticate](/docs/guides/authenticate)).
- [ ] A deploy integration or deploy target set; a preview deployment seen on a test Change.
- [ ] GitHub Actions secrets moved to your deploy platform (CI steps never get secrets).
- [ ] A last catch-up Change merged (step 3), then the GitHub repo set to read-only or archived.
- [ ] Old remotes removed from local clones: `git remote remove origin`.

**Coming soon:** an optional mirror that pushes the default branch back to GitHub, for teams mid-migration.

## Next

- Not ready to move? Grade pull requests where they are: [Connect GitHub](/docs/get-started/github).
- Tune the lanes for this repo: [Write a policy](/docs/guides/write-a-policy).
