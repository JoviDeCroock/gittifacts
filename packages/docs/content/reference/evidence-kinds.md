---
title: "Evidence kinds"
description: "The 14 evidence item kinds a signed evidence bundle can hold, with their fields."
order: 51
audience: both
generated: true
---

# Evidence kinds

Evidence is `{ changeId, headSha, items[], attestation }`, signed with Ed25519 over the canonical JSON of `{ changeId, headSha, items }`, stored in D1 and as a git note on the head commit under `refs/notes/evidence` (format `gittifacts.evidence/v1`). Read it with `get_evidence`.

> Generated from `packages/evidence/src/schema.ts` by `pnpm --filter @app/docs generate`. Don't edit this page by hand: change the code and regenerate.

## Fields every item has

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | Unique within a bundle, e.g. "red-green", "public-api", "screenshots:/settings". Tours cite these. |
| `kind` | string | One of the kinds below. |
| `status` | "ok" \| "skipped" \| "error" | ok = measured; skipped = deliberately not applicable; error = tried and failed. |
| `note?` | string | Human-readable reason when status is "error" or "skipped". |
| `logRef?` | string | Opaque pointer to raw logs/artifacts (e.g. an R2 key). |

A `skipped` or `error` item is never read as a pass: it raises the lane ([lane reasons](/docs/reference/lane-reasons)).

## Kinds

### `agent-trace`

Schema `AgentTrace`.

| Field | Type | Meaning |
| --- | --- | --- |
| `provider` | string |  |
| `traceId` | string |  |
| `url?` | string |  |

### `conflict-resolution`

Schema `ConflictResolution`. A merge conflict resolved by the platform's resolver agent (never the Change's author) when the Change no longer applied cleanly onto its new base (textual conflict), or failed together with upstream Changes although each passed alone (semantic conflict, found by batch bisection). `conflictHunks` and `touchesOutsideConflictHunks` are computed mechanically from the merge with conflict markers and the resolved files (`resolutionScope`), never taken from the model. status "error" = the resolver ran and failed (the Change is ejected, not merged). Consumers may only use this item to RAISE risk.

| Field | Type | Meaning |
| --- | --- | --- |
| `upstreamChanges` | object[] |  |
| `ontoSha?` | string | The new base the Change was rebased onto, when known. |
| `conflictHunks` | object[] |  |
| `outsideHunks?` | object[] | Head-side ranges edited outside any conflict region (what `touchesOutsideConflictHunks` found). |
| `resolutionDiff` | string | Unified diff from the mechanical merge (conflicted files with their markers) to the resolved tree. At most RESOLUTION_DIFF_MAX_BYTES UTF-8 bytes; `truncated` says it was cut. |
| `truncated` | boolean |  |
| `touchesOutsideConflictHunks` | boolean | True when any edit is not explained by replacing conflict regions (or no regions exist). |
| `novelLines?` | integer | Resolved lines found verbatim on neither side of their conflict region (written by the resolver). |
| `semanticConflictWith` | string \| null | Semantic conflicts: the upstream changeId the resolver blamed; null for textual conflicts. |
| `failingTests?` | string[] | Semantic conflicts: the test ids that failed on the merged tree before the resolution. |
| `rationale` | string | The resolver's own explanation (model text: may only raise risk). |
| `resolver` | { model, principalId, promptVersion } |  |
| `attempts` | integer | Model calls made (0 when the resolver refused before calling the model). |

### `coverage`

Schema `CoverageDelta`.

| Field | Type | Meaning |
| --- | --- | --- |
| `changedLines` | integer |  |
| `coveredChangedLines` | integer |  |
| `ratio` | number | coveredChangedLines / changedLines; 1 when no executable lines changed. |
| `files` | object[] |  |
| `unmeasuredFiles?` | string[] | Changed files with no entry at all in the coverage report. Per the contract their lines count as non-executable, so they do not affect `ratio` — but a source file missing from the report usually means "never loaded by any test". Listed so a consumer can escalate instead of reading silence as safety. |
| `selection?` | { mode, reason, files, tests } |  |

### `dependencies`

Schema `DependencyDiff`.

| Field | Type | Meaning |
| --- | --- | --- |
| `added` | object[] |  |
| `removed` | object[] |  |
| `changed` | object[] |  |
| `newInstallScripts` | object[] | Lifecycle scripts (preinstall/install/postinstall/prepare) that appear in head but not base, or whose command changed. `name` is the package name (or the manifest path when the manifest has no name). |
| `lockfileChanged` | boolean |  |

### `llm-judgment`

Schema `LlmJudgment`. A model-produced judgment. Consumers must only ever use these to RAISE risk, never to lower it.

| Field | Type | Meaning |
| --- | --- | --- |
| `question` | "scope-drift" \| "plan-conformance" \| "hidden-behavior-change" |  |
| `outcome` | "no-concern" \| "concern" \| "unsure" | "concern" means the model found something worth a human's attention. |
| `rationale` | string |  |
| `model` | string |  |

### `mutation`

Schema `MutationScore`.

| Field | Type | Meaning |
| --- | --- | --- |
| `tool` | string |  |
| `files` | string[] |  |
| `killed` | integer |  |
| `survived` | integer |  |
| `timedOut` | integer |  |
| `noCoverage` | integer |  |
| `score` | number | killed+timedOut over all valid mutants on changed lines, 0..1. |
| `survivors` | object[] |  |

### `preview`

Schema `PreviewDeploy`.

| Field | Type | Meaning |
| --- | --- | --- |
| `url?` | string |  |
| `versionId?` | string |  |
| `source?` | object |  |

### `public-api`

Schema `PublicApiDiff`.

| Field | Type | Meaning |
| --- | --- | --- |
| `classification` | "none" \| "additive" \| "breaking" |  |
| `packages` | object[] |  |

### `quarantine`

Schema `Quarantine`. Tests the merge queue quarantined as suspected-flaky (failed on main's head too). A quarantined test never silently counts as passing: every bundle whose test runs excluded or ignored quarantined tests carries this item, and `inAffectedSet` names (by test id) the ones inside the Change's affected set. An unknown affected set counts every quarantined test as affected.

| Field | Type | Meaning |
| --- | --- | --- |
| `tests` | object[] |  |
| `inAffectedSet` | string[] |  |

### `red-green`

Schema `RedGreenProof`.

| Field | Type | Meaning |
| --- | --- | --- |
| `tests` | object[] |  |
| `base` | { sha, results } |  |
| `head` | { sha, results } |  |
| `verdict` | "proven" \| "not-proven" \| "no-tests" | `tests`: the change's new/changed tests, plus pre-existing tests that fail on base (as committed) and pass, or fail differently, on head (identical failures: `preExisting`). proven: >=1 listed test fails (or is missing) on base and every one passes on head. not-proven: tests are listed but the fail-then-pass pattern does not hold. no-tests: nothing is listed (no new or changed test, and no test fails on base). |
| `preExisting?` | object[] | Pre-existing failures: tests (not new or changed by the Change) that fail on base and fail identically on head (same first line of the failure). Not listed in `tests`, so an unrelated failure on the default branch neither proves nor blocks the proof. |
| `selection?` | { mode, reason, files, tests } |  |

### `screenshots`

Schema `Screenshots`.

| Field | Type | Meaning |
| --- | --- | --- |
| `shots` | object[] |  |

### `sensitive-paths`

Schema `SensitivePathHits`.

| Field | Type | Meaning |
| --- | --- | --- |
| `patterns` | string[] |  |
| `hits` | object[] |  |

### `test-run`

Schema `TestRun`.

| Field | Type | Meaning |
| --- | --- | --- |
| `sha` | string |  |
| `step` | string |  |
| `runner` | string |  |
| `passed` | integer |  |
| `failed` | integer |  |
| `skipped` | integer |  |
| `durationMs` | number |  |
| `failures` | object[] |  |
| `preExisting?` | string[] | Names (from `failures`) that fail identically on the base commit (`baseline`): pre-existing, so they do not count against the Change. `failed` still counts every failure. |
| `baseline?` | { sha, status, source, note } |  |
| `selection?` | { mode, reason, files, tests } |  |

### `transform`

Schema `ReproducibleTransform`.

| Field | Type | Meaning |
| --- | --- | --- |
| `transform` | string |  |
| `command` | string |  |
| `verified` | boolean | True only when re-running on base in a clean sandbox reproduced every listed file byte-for-byte. |
| `files` | string[] |  |
| `mismatchedFiles` | string[] |  |
