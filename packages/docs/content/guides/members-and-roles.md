---
title: Members and roles
description: Add people to a repo as reader, reviewer, maintainer or owner; how agents inherit their owner's role; how access errors look.
order: 47
audience: humans
group: Set up a repo
---

# Members and roles

Only humans are members of a repo. Agents act with their owner's role, capped by their own scopes, and can never review, approve or administer.

| Role | Can |
|---|---|
| `reader` | Read the repo: plans, changes, evidence, tours, rollouts, its audit events |
| `reviewer` | + review Changes; their agents may draft Plans and start Changes |
| `maintainer` | + approve and reject Plans, pull the kill switch on a rollout |
| `owner` | + manage members, set the deploy target, turn Lane 0 on or off, freeze and thaw the merge queue |

Whoever creates or claims a project is its owner.

## 1. See who has access

Open the repo, then **Members** (`https://<host>/repos/<repoId>/members`). Agents can ask too:

```text
list_members({ repoId: "3fk2q8wz7m1x0c5v9nbd" })
```

Expected: each member's name and role, and `viewerRole` for you (an agent sees its owner's role).

## 2. Add someone or change a role

On the Members screen, enter a signed-up user's e-mail and pick a role. Over HTTP (owners only):

```sh
curl -s https://<host>/api/v1/repos/3fk2q8wz7m1x0c5v9nbd/members \
  -H "Cookie: $GITTIFACTS_SESSION" -H "Content-Type: application/json" \
  -d '{"email":"ada@example.com","role":"maintainer"}'
```

Expected: `200` with `{ member }`. Use `principalId` instead of `email` for a known principal. Posting an existing member changes their role.

## 3. Remove someone

```sh
curl -s -X DELETE https://<host>/api/v1/repos/3fk2q8wz7m1x0c5v9nbd/members/hu_8d2k \
  -H "Cookie: $GITTIFACTS_SESSION"
```

Owners remove anyone; a member can remove themselves. A change that would leave the repo without an owner fails with `409`.

## How access looks from outside

- A repo you aren't a member of answers `404`, exactly like one that doesn't exist, on every route and tool.
- With the wrong role: `403` naming what you tried ("approving plans and pulling the kill switch") with a fix pointing at `list_members`.
- An agent whose owner lost access loses it too, on the next request.

## Separation of duties

- No one approves their own Plan or reviews their own Change.
- An agent's owner may review that agent's Change; the audit log records it.
- Integrations get `reader` on the repos of their installation, and only while the installer is still a member.
