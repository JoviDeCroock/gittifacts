---
title: Commit and push with git
nav: Commit and push with git
description: Plain git push from a CLI clone (credential helper), push tokens, Bearer-header auth for Artifacts tokens, refreshing an expired token, and read-only clones of a repo.
order: 13
audience: both
group: Daily work
---

# Commit and push with git

**You'll have:** your commits pushed to a Change's fork with a short-lived grant, and the evidence notes fetched next to them.

Standard git works against gittifacts. You push to your Change's **fork** with a short-lived push token; you never push to the default branch.

## From a CLI clone: plain `git push`

In a clone made by `gittifacts init --clone` or `gittifacts clone`, git is already set up:

```sh
git commit -am "Add /time"
git push
```

Expected: a normal `git push` summary. `origin` is the current Change's fork, `remote.origin.push` targets its branch, and the clone's local credential helper is `gittifacts git-credential`. On each push it asks `refresh_push_token` for the Change named in `.gittifacts.json` and answers git with Basic auth (the token without its `?expires=` suffix). Nothing secret is written to `.git/config`. `gittifacts ship` does the same push, starts a new Change once the last one merged, and points `origin` at the new fork.

<details>
<summary>Check the helper, or see what it answers</summary>

```sh
git config --get-regexp 'credential\..*\.helper'
printf 'protocol=https\nhost=<artifacts-host>\n\n' | git credential fill
```

Expected: two entries per origin (an empty one, which keeps a global keychain helper from storing hour-long tokens, then the `gittifacts git-credential` command), and `username=x` with a fresh `password`.

</details>

The rest of this page is git without the CLI.

## The push token

`start_change` (and `create_project`, for your first Change) returns `remote`:

| Field | Meaning |
|---|---|
| `url` | The fork's git URL (smart HTTP, an Artifacts repo `task-<changeId>`) |
| `token` | An Artifacts token for that fork only, including its `?expires=<unix>` suffix |
| `username` | Any non-empty name; Basic auth ignores it |
| `branch` | The branch to push (the repo's default branch name, on the fork) |
| `expiresAt` | When the token stops working: at most 1 hour after it was minted |

## 1. Push with a Bearer header (recommended)

Bearer takes the whole token, `?expires=` suffix included. Keep it out of argv and `.git/config` by passing it through git's environment:

```sh
export PUSH_URL="<remote.url>" PUSH_TOKEN="<remote.token>" PUSH_BRANCH="<remote.branch>"
export GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=http.extraHeader
export GIT_CONFIG_VALUE_0="Authorization: Bearer $PUSH_TOKEN"
export GIT_CONFIG_KEY_1=http.postBuffer GIT_CONFIG_VALUE_1=524288000
git push "$PUSH_URL" "HEAD:refs/heads/$PUSH_BRANCH"
```

The one-liner form works too, but leaves the token in your shell history:

```sh
git -c http.extraHeader="Authorization: Bearer $PUSH_TOKEN" -c http.postBuffer=524288000 \
  push "$PUSH_URL" "HEAD:refs/heads/$PUSH_BRANCH"
```

Expected: a normal `git push` summary. The platform sees the push within seconds and starts CI for the new head.

`http.postBuffer` matters once a push is larger than 1 MiB (images, lockfiles, a first push of history): git then sends the request body chunked, Artifacts refuses chunked bodies, and git reports `the remote end hung up unexpectedly`. A larger buffer keeps the body in one piece. Small pushes work without it.

## 2. Or use Basic auth

Basic auth needs the token **without** its `?expires=` suffix as the password, and any non-empty username:

```sh
git push "https://x:${PUSH_TOKEN%%\?expires=*}@${PUSH_URL#https://}" "HEAD:refs/heads/$PUSH_BRANCH"
```

This writes the secret into the remote URL; prefer the header.

## 3. Clone the fork

The fork starts as a copy of the default branch, so cloning it gets you the repo:

```sh
git clone "$PUSH_URL" work && cd work
```

(With the `GIT_CONFIG_*` variables from step 1 still exported.) Pushing again later is normal: each push starts a new pipeline and cancels the run for the older head.

## 4. Refresh an expired grant

A push after `expiresAt` fails with HTTP 401 or 403 from git. Get a fresh token for the same fork; only the Change's author can:

```text
refresh_push_token({ changeId: "7h2kd9x0qw3m5z8r1vtc" })
```

```sh
gittifacts refresh-push-token 7h2kd9x0qw3m5z8r1vtc
```

Expected: a new `remote` with a new `token` and `expiresAt`. Export the new token and push again. Nothing else about the Change changes.

## 5. Read a repo without a Change

The platform also serves read-only git at `https://<host>/git/<owner>/<repo>.git` (a Change's fork: `/git/<owner>/<repo>/changes/<changeId>.git`). Use an agent token with `repo:read`:

```sh
git -c http.extraHeader="Authorization: Bearer $GITTIFACTS_TOKEN" clone "https://<host>/git/<owner>/<repo>.git"
```

`git push` to this URL is always refused (`403 read-only`). Unclaimed repos have no `/git/` URL. `<owner>` is the owner's handle, set when the repo is claimed.

## 6. Fetch the evidence and why notes

Signed evidence rides along as git notes on each head commit:

```sh
git fetch origin 'refs/notes/evidence:refs/notes/evidence'
git log --notes=evidence -1
```

Every commit the merge queue lands also carries a signed note saying why it exists: the approved plan's intent, the author and the human accountable for it, the lane and the approvals.

```sh
git fetch origin 'refs/notes/why:refs/notes/why'
git log --notes=why -1
```

## Errors you may see

| Symptom | Cause | Fix |
|---|---|---|
| `403` pushing to the main repo URL | Only the merge queue writes the default branch (`push-to-main`) | `start_change`, then push to its fork |
| `401`/`403` on a fork push | The token expired or belongs to another Change | In a CLI clone, `gittifacts ship`; else `refresh_push_token` (author only) |
| `HTTP 400` and `the remote end hung up unexpectedly` | A push over 1 MiB went out chunked; Artifacts refuses chunked bodies | Push again with `-c http.postBuffer=524288000` |
| Push accepted, nothing happens | You pushed a tag or a ref other than the branch | Push `HEAD:refs/heads/<remote.branch>` |
| `429 quota-exceeded` | Unclaimed repo out of Artifacts operations | Claim the repo ([Claim a repo](/docs/guides/claim-a-project)) |
