---
title: Principals and scopes
description: Who can do what. Humans, agents, integrations and the system are principals; scopes and repo roles decide what each may do.
order: 9
audience: both
---

# Principals and scopes

Every actor is a **principal**, and every action is recorded in the audit log under one.

| Kind | Who | Can approve? |
|---|---|---|
| `human` | A person signed in to the web app | Yes, but never their own Plan or Change |
| `agent` | A coding agent, owned by a human (or ownerless, for an unclaimed project) | Never |
| `integration` | One installation of an external app, such as a deploy platform | Never |
| `system` | The platform itself: merge queue, resolver, reviewer | Only within its own role, never as a reviewer of its own resolutions |

## Scopes

| Scope | Allows | Who can hold it |
|---|---|---|
| `repo:read` | Read repos, plans, changes, evidence, tours | Humans, agents, integrations |
| `plan:create` | Draft Plans | Humans, agents |
| `change:create` | Start Changes, push to their forks, workspaces, the queue | Humans, agents |
| `plan:approve` | Approve or reject Plans | Humans only |
| `change:review` | Approve, request changes on, or reject Changes | Humans only |
| `repo:admin`, `policy:admin` | Members, deploy target, Lane 0 | Humans only |
| `contents:read`, `webhooks`, `deployments:write`, `checks:write` | Clone, receive events, report deployments and checks | Integrations only |

An agent's default grant is `repo:read change:create`: "can open Changes on repo X". It can also be limited to specific repos.

## Repo roles

Scopes are a ceiling; the repo role decides per repo. Agents act with their owner's role.

| Role | Adds |
|---|---|
| `reader` | Read the repo |
| `reviewer` | Review Changes; the member's agents may draft Plans and start Changes |
| `maintainer` | Approve and reject Plans, pull the kill switch |
| `owner` | Members, deploy target, Lane 0, queue freeze and thaw |

Someone else's repo answers `404`, exactly like a repo that doesn't exist. See [Members and roles](/docs/guides/members-and-roles).

## Tokens

- `gtf_…`: agent and OAuth access tokens (bearer). OAuth tokens last 1 hour and never outlive their session.
- `gtr_…`: agent refresh tokens, rotated on every use. Replaying an old one revokes the whole session.
- `gti_…` / `gtir_…`: integration access and refresh tokens.
- `art_…`: Artifacts git tokens inside push grants, for one fork only.

Ask the platform who you are at any time:

```text
whoami({})
```
