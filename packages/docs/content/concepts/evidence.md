---
title: Evidence
description: Signed, machine-checked facts about a Change's head commit. The classifier routes on them and tours cite them.
order: 3
audience: both
---

# Evidence

**Evidence** is what the machines prove about a Change: test results, a red/green proof for fixes, coverage and mutation score on changed lines, the public API and dependency diffs, sensitive-path hits, a preview with screenshots, and more. It is computed on the exact head commit, signed by the platform, and travels with the repo.

## What runs

After your own CI steps, the platform adds its evidence steps:

| Evidence | Proves | Raises the lane when |
|---|---|---|
| `red-green` | A test fails on the base commit and passes on the head | A claimed fix has no proof |
| `test-run` | Which tests passed and failed | Any test failed |
| `coverage` | Changed lines covered by tests | Below the policy threshold (default 0.8) |
| `mutation` | Mutants on changed lines killed by tests | Below the threshold (default 0.6) |
| `public-api` | Exported surface: `none`, `additive` or `breaking` | Additive (Lane 1) or breaking (Lane 2) |
| `dependencies` | Added, removed and major-bumped deps, new install scripts | New dependencies (Lane 2) |
| `sensitive-paths` | Hits on the policy's sensitive globs | Any hit (Lane 2) |
| `preview`, `screenshots` | The Change runs, and how its routes look | The preview fails to start |
| `transform` | A declared codemod reproduces hunks byte for byte | Never; verified hunks are hidden from review |

Also possible: `agent-trace`, `llm-judgment` (raise-only), `conflict-resolution` and `quarantine` from the merge queue. Fields of every kind: [Evidence kinds](/docs/reference/evidence-kinds).

## Unknown is never green

Every item has a `status`: `ok` (measured), `skipped` (not applicable) or `error` (tried and failed). A skipped or errored signal raises the lane; it never counts as a pass. A broken check can't become the cheapest route to Lane 0.

## Signed, and stored twice

```text
bundle = { changeId, headSha, items[] }
attestation = Ed25519(platform key, canonical JSON of bundle)
stored in D1 and as a git note on the head commit: refs/notes/evidence
```

The public keys are at `https://<host>/.well-known/gittifacts-keys.json`. Anyone with a clone can verify a commit's evidence without trusting the platform's database:

```sh
git fetch origin 'refs/notes/*:refs/notes/*'
pnpm verify-attestation --repo . --commit HEAD --keys-url https://<host>/.well-known/gittifacts-keys.json
```

Exit code 0 means verified, 1 not verified, 2 a usage error. More in the [Security model](/docs/security#verify-signed-evidence).

## Read it

```text
get_evidence({ changeId: "ch_5mz1" })
```

Expected: `items[]` with `kind`, `status` and a summary per item, plus `verification: { ok: true, keyId }`.
