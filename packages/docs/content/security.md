---
title: Security model
description: What agents and integrations can never do, separation of duties, signed evidence and how to verify it, the audit log, and where data lives.
order: 900
audience: both
---

# Security model

The product rule is also the security model: humans approve intent, machines prove conformance. Every rule below is enforced in code and covered by tests, not left to convention.

## What agents can never do

- **Approve.** Agents can't hold `plan:approve`, `change:review`, `repo:admin` or `policy:admin`, whatever their owner's role. Asking for them fails at every door (consent, device flow, token creation, refresh).
- **Write the default branch.** Agent push grants are Artifacts tokens for one Change's fork, valid for at most an hour. Only the merge queue writes the default branch; its write tokens live inside it for at most 5 minutes and are never returned.
- **Relax their own rules.** Policy is read from the Change's base commit. A Change touching `.platform/**` is always Lane 2 and needs a human's approval.
- **Lower a lane.** Missing or errored signals raise the lane. LLM judgments, external checks and conflict resolutions may only raise it.
- **See secrets.** CI steps, previews and workspaces get no platform secrets and no production bindings. Workspace commands never see a git token.
- **Reach production from an unclaimed project.** No deploy target, no secrets, no Lane 0, no integrations; previews only.

Integrations are held tighter still: read code, receive events, report deployments. They can never push (`git-receive-pack` is refused), approve, see push tokens or connect to unclaimed projects.

## Separation of duties

| Act | Who may | Who may not |
|---|---|---|
| Approve a Plan | A human maintainer or owner | Its author; any agent |
| Review a Change | A human reviewer or above | Its author; any agent |
| Write the tour | A reviewer agent with its own context | The authoring agent; it never sees the author's summary |
| Resolve a merge conflict | The resolver (`system:resolver`) | The Change's author; its resolution is re-classified and may need a fresh approval |
| Turn on Lane 0 | A human owner, after measured agreement | Anyone before the threshold |

An agent's owner may review that agent's Change; the audit log records it.

## Signed evidence, and how to verify it

Evidence is signed with the platform's Ed25519 key over the canonical JSON of `{ changeId, headSha, items }`. It is stored in D1 and as a git note on the head commit (`refs/notes/evidence`), so it travels with every clone. Plan approvals and audit entries are signed with the same key.

### Verify signed evidence

```sh
git fetch origin 'refs/notes/evidence:refs/notes/evidence'
pnpm verify-attestation --repo . --commit HEAD --keys-url https://<host>/.well-known/gittifacts-keys.json
```

Run it from a checkout of the gittifacts repository (the verifier is `@app/evidence`, a standalone package with no platform dependencies). Exit code 0 means the note is signed by a published key and bound to that commit; 1 means it isn't. `GET /api/v1/changes/<changeId>/evidence` re-verifies on every read and returns `verification: { ok, keyId }`.

## Audit log

Every transition (plan approved, push received, lane assigned, review, merge, rollout stage, kill, revert, token issued, member added, integration installed) is an audit event.

- One Durable Object writes the log: append-only, each entry hash-chained to the previous one and signed.
- `GET /api/v1/audit?subject=change:<changeId>` returns the events and `chain: { verified, brokenAt? }`.
- Humans read it at `https://<host>/audit`. Each event has a one-line summary, such as "Stage 25% started".

## Data residency

- Repos live in the Artifacts namespace `gittifacts-eu` (EU jurisdiction). Metadata (D1) and logs, artifacts and screenshots (R2) are in the EU too.
- **Coming soon:** choosing another jurisdiction per organization.

## Previews and webhooks

- Previews run on a separate domain (`*-pv.resynapse.dev`) with a banner, `noindex`, no framing, no internet access and no secrets.
- Webhooks are signed: `X-Gittifacts-Signature-256` is an HMAC-SHA-256 of the raw body with your webhook secret. Stored webhook secrets are sealed with AES-256-GCM.

## Abuse limits

Credential-less creation (when on) is rate-limited per IP, per network and platform-wide, behind a kill switch that fails closed. Unclaimed projects have CI, storage and Artifacts quotas and registries-only egress. Every number: [Limits and quotas](/docs/reference/limits).

Found a problem? Open an issue on the gittifacts repository, or tell the team directly for anything sensitive.
