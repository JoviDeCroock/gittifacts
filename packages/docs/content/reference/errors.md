---
title: "Error codes and fixes"
nav: "Error codes"
description: "Every platform error code with its HTTP status and the fix the platform sends with it, plus merge-queue ejection codes."
order: 50
audience: both
generated: true
---

# Error codes and fixes

Every error from the HTTP API, the MCP server and the CLI has this shape. `fix.call` is an MCP tool call and `fix.command` a shell command that resolves it; run them as they are. Placeholders such as `<changeId>` are filled in with real ids in live errors.

> Generated from `packages/conventions/src/fixes.ts`, `packages/merge-queue/src/eject.ts`, `packages/merge-queue/src/schema.ts` by `pnpm --filter @app/docs generate`. Don't edit this page by hand: change the code and regenerate.

```json
{ "error": { "code": "plan-not-approved", "message": "…", "fix": { "explanation": "…", "call": "get_change_status({ changeId: \"chg_1\" })", "docsUrl": "https://<host>/start" } } }
```

## Platform errors

| Code | HTTP | What to do | Next call or command |
| --- | --- | --- | --- |
| `unauthorized` | 401 | Send `Authorization: Bearer <token>`. No token? Call create_project without credentials to get an unclaimed repo and a token, use MCP OAuth (discovered from the 401's resource_metadata), or ask a human for an agent token. <host>/start explains each. | `curl -s <host>/start` |
| `insufficient-scope` | 403 | Your token lacks a scope this call needs. Agents can hold only repo:read, plan:create and change:create; ask the human who owns the agent to grant it, or hand the step to a human. whoami lists the scopes you have. | `whoami({})` |
| `scope-not-allowed` | 403 | Agents may hold only repo:read, plan:create and change:create, and a human can only delegate scopes they hold. Request a subset. | `whoami({})` |
| `forbidden` | 403 | You may not do this here. whoami lists what you may do on each repo; approving and reviewing are a person's acts (ask one with request_review). | `whoami({})` |
| `self-approval` | 403 | Nobody approves their own Plan or Change, and agents approve nothing. Ask a different human to review it. | `request_review({ changeId: "<changeId>" })` |
| `turnstile-failed` | 403 | The human-verification check (Turnstile) failed or expired. Reload the claim page, complete the check again and retry the claim. | `open <claimUrl>` |
| `push-to-main` | 403 | Only the merge queue writes main. Open a Change: it returns a fork remote and a push token for it. Push there, then wait for evidence. | `start_change({ repoId: "<repoId>", title: "<what you changed>", category: "feature" })` |
| `red-green-missing` | 422 | This Change claims a fix but adds or changes no test. Add a test under `test/` that fails on the base commit and passes on your head: write it first, run `pnpm exec vitest run test/<area>.test.ts` before the fix (it must fail), fix, run it again (it must pass), then push both. Without this proof a fix gets a full review (Lane 2) and can't auto-merge. | `pnpm exec vitest run test/<area>.test.ts` |
| `plan-not-approved` | 409 | Plan <planId> is not approved; only a human can approve it (you can't). Ask them to review it, or start the Change without planId: it runs CI but can't auto-merge. | `start_change({ repoId: "<repoId>", title: "<what>", category: "feature" })` |
| `stale-head` | 409 | The Change moved on: a newer push or a merge-queue rebase. Reviews and results bind to one head. Re-read the status; if your push was rejected, pull the fork and rebase onto it. | `get_change_status({ changeId: "<changeId>" })` or `git -c http.extraHeader="Authorization: Bearer <remote.token>" pull --rebase <remote.url> <remote.branch>` |
| `invalid-state` | 409 | The resource's current status doesn't allow this. Read it again and act on its current status. | `get_change_status({ changeId: "<changeId>" })` |
| `threshold-not-met` | 409 | Auto-merge unlocks only after enough human reviews agree with the classifier's auto-merge calls (the repo is calibrating). Keep shipping reviewed Changes; the repo shows how many are still needed. | `whoami({})` |
| `quota-exceeded` | 429 | You hit a quota. whoami shows your quotas and what is left. Unclaimed repos have tight quotas: a human claiming the repo (its claimUrl from create_project) raises them. | `whoami({})` |
| `unclaimed-limit` | 403 | Unclaimed repos can't do this (no secrets, custom domains, production deploys or auto-merge). A human must claim the repo first with the claimUrl from create_project. | `whoami({})` |
| `creation-disabled` | 503 | Creating unclaimed repos (no credentials) is switched off right now (kill switch). Authenticate with MCP OAuth (discovered from the MCP server's 401 resource_metadata) or an agent token from a human, then call create_project again: the repo is created claimed. | `curl -s <host>/start` |
| `rate-limited` | 429 | Too many requests. Wait 10s (or the Retry-After header), then retry the same request with the same Idempotency-Key. | `sleep 10` |
| `idempotency-key-reuse` | 409 | This Idempotency-Key was already used with a different request. Reuse a key only to retry the identical request; send a new key for a new request. | `uuidgen` |
| `idempotency-key-in-flight` | 409 | The first request with this Idempotency-Key is still running. Retry the same request in a second. | `sleep 1` |
| `invalid-request` | 400 | The request failed validation. `details` lists each field and what is wrong; fix them and resend. Tool schemas: search_tools. | `search_tools({ query: "<tool name>" })` |
| `invalid-input` | 400 | The platform rejected an input. Read `message`, correct that field and resend. | `search_tools({ query: "<tool name>" })` |
| `not-found` | 404 | No resource with that id exists, or you can't see it (it may also not be ready yet). List what exists and use one of those ids. | `list_repos({})` |
| `conflict` | 409 | The request conflicts with the current state. Read the resource again and act on what is there now. | `get_change_status({ changeId: "<changeId>" })` |
| `payload-too-large` | 413 | The body is too large. Send less: push code with git instead of in a request, and split large Changes. | `git -c http.extraHeader="Authorization: Bearer <remote.token>" push <remote.url> HEAD:<remote.branch>` |
| `http-error` | 400 | The HTTP request was not acceptable. Check the method, the path and `Content-Type: application/json`. | `curl -s <host>/openapi.json` |
| `upstream` | 502 | A platform dependency failed or isn't ready yet. Retry in a few seconds with the same Idempotency-Key; the retry is safe. | `sleep 5` |
| `internal` | 500 | Unexpected platform error. Retrying with the same Idempotency-Key is safe; if it keeps failing, report the x-gittifacts-version header value. | `sleep 5` |

## Aliases

Older names map to the codes above.

| Alias | Code |
| --- | --- |
| `unauthenticated` | `unauthorized` |
| `forbidden-scope` | `insufficient-scope` |
| `fix-without-red-green` | `red-green-missing` |
| `red-green-proof-missing` | `red-green-missing` |
| `stale-ref` | `stale-head` |
| `too-many-requests` | `rate-limited` |
| `kill-switch` | `creation-disabled` |

## Merge-queue ejections

An ejected queue entry carries `{ code, message, fix, evidenceRefs, failingTests, upstream }`. `wait_for_merge` and `queue_status` return it.

| Code | When | What to do | Next call or command |
| --- | --- | --- | --- |
| `tests-failed` | The entry is the bisected culprit of a real (reproduced, not flaky) test failure. | On the queue's tree (main + the batch ahead of it) your Change fails <test>. The failure reproduced on that tree and not on main, so it is not a flake. Fix the test failures on top of current main, push, and enqueue again. | `open_workspace({ changeId: "<changeId>" })` or `git fetch origin main && git rebase origin/main` |
| `semantic-conflict` | The entry fails only together with an upstream Change, and the resolver could not fix it. | Your Change passes on its own but fails <test> together with upstream <upstreamChangeId>, and the resolver could not fix it. Rebase onto current main (which now contains <upstreamChangeId>), adapt your Change to it, and enqueue again. | `open_workspace({ changeId: "<changeId>" })` or `git fetch origin main && git rebase origin/main` |
| `textual-conflict` | The entry no longer applies cleanly and the resolver could not resolve it. | Your Change no longer applies cleanly (<file>) after <upstreamChangeId>, and the resolver could not resolve it twice. Rebase onto current main, resolve the conflicts, push and enqueue again. | `open_workspace({ changeId: "<changeId>" })` or `git fetch origin main && git rebase origin/main` |
| `resolution-budget-exhausted` | The resolver ran out of AI Gateway budget. | The conflict resolver ran out of AI budget for this Change. Resolve the conflict yourself: rebase onto current main, push and enqueue again. | `open_workspace({ changeId: "<changeId>" })` or `git fetch origin main && git rebase origin/main` |
| `dependency-ejected` | An entry this one depends on (stack) was ejected or dequeued. | This Change is stacked on <upstreamChangeId>, which left the queue. Fix and re-enqueue <upstreamChangeId> first, then enqueue this Change again. | `queue_status({ changeId: "<upstreamChangeId>" })` |
| `group-member-failed` | Another member of this entry's land-together plan group (or atomic stack) failed. | This Change lands together with <upstreamChangeId>, and one of them failed. Nothing in the group merged. Once the failing member is fixed, enqueue the whole group again. | `queue_status({ changeId: "<upstreamChangeId>" })` |
| `infra-error` | Repeated infrastructure errors (CI could not produce a result). | CI could not produce a result for this Change several times in a row (infrastructure, not your code). Enqueue it again. | `enqueue({ changeId: "<changeId>" })` |
| `superseded` | A newer head was enqueued for the same Change. | A newer head of this Change was enqueued; this one was replaced. | `queue_status({ changeId: "<changeId>" })` |
