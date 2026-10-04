---
title: Import a private repo
description: A human owner creates an empty repo and pushes the history once with a one-time grant. Detection then proposes the platform config, as for a public import.
order: 43
audience: humans
group: Set up a repo
---

# Import a private repo

**You'll have:** a private repo's full history on gittifacts, and detection proposing its platform config.

Public repos import with one command ([Move a repo from GitHub](/docs/get-started/from-github)). Imports with `from` take public `https://` URLs only, so a private repo comes in by push: a human owner creates an empty repo and pushes the history once. Agents can't do this.

## 1. Create an empty repo

Signed in, with your browser session's cookies saved to `cookies.txt` (for example with your browser's cookie export):

```sh
curl -X POST "https://<host>/api/v1/projects" -b cookies.txt -H "content-type: application/json" \
  --data '{ "name": "clock-api", "importMode": "push" }'
```

Expected: `projectId` and an `importGrant` with `url`, `token`, `expiresAt` and a `command`.

## 2. Push the history, in one push

The token writes the repo's main repo, so treat it like a password: put it in an environment variable, never in the remote URL or git config.

```sh
export GITTIFACTS_IMPORT_TOKEN='<importGrant.token>'
git -c http.extraHeader="Authorization: Bearer $GITTIFACTS_IMPORT_TOKEN" -c http.postBuffer=524288000 \
  push "<importGrant.url>" main:refs/heads/main --follow-tags
```

Expected: git reports the branch and tags as new.

<details>
<summary>Why http.postBuffer, and what to do when the push fails</summary>

Artifacts refuses chunked uploads, and git sends any push over 1 MiB chunked unless the buffer is larger. Without it a real history fails with `the remote end hung up unexpectedly` (HTTP 400), and the grant stays open, so you can retry.

</details>

## 3. Check the grant closed

```sh
curl -b cookies.txt "https://<host>/api/v1/repos/<projectId>/import-grant"
```

Expected: `status: "closed"`, `closeReason: "pushed"`, `imported: true` and `mainSha` equal to your local `git rev-parse main`. Detection starts by itself after a push import: [step 3 of the import path](/docs/get-started/from-github#3-get-the-setup-proposal) picks up its proposal.

<details>
<summary>When the grant closes, and why this exception is safe</summary>

The grant closes at the first of: the first push to the repo, the first Change, or 30 minutes. Closing revokes the token. From then on only the merge queue writes the default branch. This is the one exception to that rule: an empty repo, its human owner, before any Change, and both the opening and the closing are in the audit log (`project.import-push-opened`, `project.import-push-closed`).

If the push failed or the grant expired first, `imported` is `false` and the owner can open a new grant (`POST /api/v1/repos/<projectId>/import-grant`) as long as the default branch doesn't exist.

</details>

## Next

- Approve the proposal and move people over: [Migrate from GitHub](/docs/guides/migrate-from-github).
