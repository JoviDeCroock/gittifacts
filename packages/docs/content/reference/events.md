---
title: "Webhook and stream events"
nav: "Events"
description: "Webhook events integrations can subscribe to, how deliveries are signed and retried, and the merge-queue and Change event streams."
order: 54
audience: both
generated: true
---

# Webhook and stream events

> Generated from `apps/platform/src/integrations/scopes.ts`, `apps/platform/src/integrations/delivery.ts`, `packages/merge-queue/src/schema.ts` by `pnpm --filter @app/docs generate`. Don't edit this page by hand: change the code and regenerate.

## Webhook events

Delivered to an integration's webhook URL for the repos its installation covers, when the installation holds `webhooks`. Default subscription: `push`, `change.created`, `change.updated`, `change.merged`, `change.reverted`, `installation.created`, `installation.deleted`.

| Event | When |
| --- | --- |
| `push` | A branch was pushed: the default branch of the repo, or the branch of a Change's fork. Carries `ref`, `before`, `after` and the clone URL. |
| `change.created` | A Change was opened (`start_change`). |
| `change.updated` | A Change's status, head, lane, evidence or tour changed (`changedFields`). |
| `change.merged` | The merge queue landed the Change on the default branch (`sha` = the merged commit). |
| `change.reverted` | The Change was reverted after merge. |
| `installation.created` | The integration was installed (or its repo selection updated). |
| `installation.deleted` | The integration was uninstalled. The last event an installation receives. |
| `ping` | Sent on demand from the developer portal to test the endpoint. Always delivered. |

Every delivery is a `POST` with a JSON body `{ event, action, deliveryId, createdAt, installation, repository, … }` and these headers:

| Header | Value |
| --- | --- |
| `X-Gittifacts-Event` | The event name. |
| `X-Gittifacts-Delivery` | Delivery id. A redelivery keeps it. |
| `X-Gittifacts-Signature-256` | `sha256=<hex HMAC-SHA-256 of the raw body>` with the webhook secret. |
| `User-Agent` | `gittifacts-Hookshot/1` |

Delivery is at least once: dedupe on `X-Gittifacts-Delivery`. A non-2xx answer is retried 7 times (10 s, 30 s, 2 min, 10 min, 30 min, 60 min, 120 min). Verification code: [Webhooks guide](/docs/guides/integrations/webhooks).

## Integration permissions

| Scope | Shown as | Allows |
| --- | --- | --- |
| `repo:read` | Read repository metadata | See the repository's name, branches, commits, Changes and their status. |
| `contents:read` | Clone the code | Clone and fetch the repository and its Change heads over git, read-only. |
| `webhooks` | Receive events | Get notified when the default branch or a Change is pushed, and when Changes are created, updated, merged or reverted. |
| `deployments:write` | Report deployments | Post deployment status and preview URLs. A successful preview is attached to its Change as signed evidence. |
| `checks:write` | Report checks | Attach external check results to Changes. They can only raise a Change's risk lane, never lower it. |

Never possible for an integration: push code or write any branch; approve, review or merge changes; change repository settings, policy or secrets; see your agents' push tokens; connect to unclaimed projects.

## Merge-queue events

`GET /api/v1/repos/{repoId}/queue/events` streams these as Server-Sent Events (event ids are sequence numbers: reconnect with `Last-Event-ID` to resume).

| Type | Fields |
| --- | --- |
| `entered_batch` | `at`, `changeId`, `batchId`, `trackId`, `position`, `batchSize`, `predictedPassProbability` |
| `resolving_conflict` | `at`, `changeId`, `kind`, `upstream`, `attempt` |
| `resolution_ready` | `at`, `changeId`, `newHeadSha`, `lane`, `blamedUpstream`, `approvalRequired` |
| `ejected` | `at`, `changeId`, `reason` |
| `merged` | `at`, `changeId`, `mergedSha`, `treeSha`, `casId`, `timeInQueueMs`, `lane`, `deploysTo`, `flagKey`, `files`, `modules` |
| `deployed` | `at`, `trainId`, `worker`, `versionId`, `changeIds` |
| `flag_killed` | `at`, `trainId`, `worker`, `changeId`, `flagKey`, `issueId` |
| `frozen` | `at`, `reason` |
| `thawed` | `at`, `by`, `invalidatedBatches` |

## Change events

`GET /api/v1/changes/{changeId}/events` streams one `change` event (`{ change }`) per update until the Change reaches a final status. Agents usually call `wait_for_change` instead.
