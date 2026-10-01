# Status

_Last updated: 2026-10-01_

Specs: `docs/prompts/01-platform.md` (platform, M1–M5) and `docs/prompts/02-onboarding.md` (agent onboarding, O1–O6).

## Milestones
| Milestone | State |
|---|---|
| M1 Vertical slice | building: platform Worker, coordinator, ci-engine and sandbox in progress |
| M2 Evidence | evidence package done; sandbox runner producing real evidence for the fixtures in progress |
| M3 Classifier + tour | classifier done (413 tests); tour reviewer and web UI in progress |
| M4 Merge, rollout, revert | gitwire done and verified live; merge queue + rollout in progress (coordinator) |
| M5 Mutation, transforms, screenshots, dogfood | mutation + transforms in progress in the sandbox runner |
| O1 Front door + templates | conventions + 4 templates in progress |
| O2 Ergonomics | error `fix` shape, idempotency, `wait_for_change`, `whoami` are being built into platform/coordinator |
| O3–O6 | planned |

## What works (tested)
- `@app/evidence`: canonical JSON, Ed25519 attestations, git-notes format, pure evidence producers, a standalone verify CLI (285 tests).
- `@app/classifier`: pure `classify()`, 93 reason codes, shadow agreement, 9 fixture scenarios (413 tests).
- `@app/gitwire`: git smart-HTTP client for Workers (receive-pack CAS, upload-pack v2, packs, notes, cross-repo transfer).
  58 tests against `git http-backend`, plus a live smoke against Artifacts that passes.
- `fixtures/`: 9 fixture repos with a materializer; `scripts/check-fixtures.ts` verifies them end to end.

## Live infrastructure (see docs/deploy.md)
Artifacts namespace `gittifacts-eu` (EU), D1 `gittifacts` (EU), R2 `gittifacts-blobs` (EU), AI Gateway `gittifacts`,
Flagship app `gittifacts-changes`. Preview domain: `*.preview.resynapse.dev` (gateway not deployed yet).

## Mocked / not yet real
- Nothing deployed yet.

## Next
1. Integrate the in-flight packages into the platform Worker and deploy (needs `wrangler login` with fresh scopes).
2. M1 e2e against the real platform: an agent clones a fork, pushes, and gets test results through MCP.
3. O1: `create_project` from templates in under 60s, through the preview gateway.
