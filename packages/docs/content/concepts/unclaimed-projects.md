---
title: Unclaimed projects
description: Projects an agent creates without an account. Tightly limited until a human claims them; deleted after 7 days otherwise.
order: 8
audience: both
---

# Unclaimed projects

**Coming soon.** Credential-less creation is built and tested but switched off on the hosted platform until repo membership ships. `/start` and `/llms.txt` say whether it is on right now.

An agent with no account calls `create_project` without a token. It gets an **unclaimed** project, a bearer token for that project only, and a `claimUrl` to hand to a human. Modeled on Cloudflare's workers.new playground.

```text
create_project({ template: "workers-api" })
```

Expected (no `Authorization` header): `token` is a `gtf_…` bearer for this project, `claimUrl` is `https://<host>/claim/gtc_…`, and `nextSteps` tells you to pass the claim link to a human.

## What an unclaimed project can't do

Unclaimed projects are the main abuse vector, so they get hard limits from the first call:

- previews only: no production deploys, no secrets, no custom domains, no deploy integrations;
- no Lane 0 and no auto-merge of any kind;
- CI and workspaces reach package registries only;
- tight quotas: 60 CI minutes a day, 10 per run, 200 MB of stored logs and artifacts, 300 Artifacts operations a day, 5 open Changes, 3 live previews;
- creation rate limits per IP, per network (ASN) and platform-wide, plus a kill switch.

Every number: [Limits and quotas](/docs/reference/limits#unclaimed-projects). Previews of unclaimed projects carry an "Unclaimed project — not verified" banner.

## Claiming

A human opens the `claimUrl`, signs in and passes a Turnstile check. The project becomes theirs: every limit lifts at once, the agent keeps working with the same token (now owned by that human, still unable to approve), and the human becomes the repo's owner. See [Claim a project](/docs/guides/claim-a-project).

## Expiry

Unclaimed projects expire after 7 days. The platform then revokes the token, stops CI, workspaces and previews, and deletes the repo, its forks and stored artifacts. The audit log keeps a record that it existed.
