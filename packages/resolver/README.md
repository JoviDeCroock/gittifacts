# @app/resolver

The merge queue's **resolver agent** (merge-queue spec §4.4). When a Change no longer applies
onto its batch base (textual conflict), or fails together with upstream Changes although each
passed alone (semantic conflict, found by bisection), the queue asks the resolver before ejecting.

```ts
import { createResolver } from "@app/resolver";
import { reviewerLlmFromEnv } from "@app/tour";

const resolver = createResolver(reviewerLlmFromEnv(env, { model: policy.ai.reviewerModel }));
const outcome = await resolver.resolve({
  change: { id, title, baseSha, headSha },   // only these fields; no summary, claim or trace
  plan, diff,                                 // the Change's plan and base..head diff
  upstream: [{ changeId, sha, title, plan, diff }],
  merge,                                      // `gittifacts-runner merge-attempt` document
  files,                                      // merged-tree files it may read/edit (optional)
  semantic: { failingTests, candidates },     // semantic conflicts only
  budget: { changeId, limitUsd, spentUsd },   // the per-change AI Gateway budget
  excludePrincipals: [authorId],
});
```

## Flow (the queue shell's side)

1. `gittifacts-runner merge-attempt --base <change base> --onto <batch base> --head <change head>`
   → `clean` (`newSha`) or `conflict` (`conflictSha` + files with base/ours/theirs and 13-char
   markers). See `apps/sandbox/README.md`.
2. `resolver.resolve(input)` →
   - `resolved`: `patch` (unified diff from `applyOnto` to the resolved tree), `files`, `scope`, and
     an `ok` **`conflict-resolution` evidence item**;
   - `ejected`: an `eject` reason `{ code, cause, message, fix, evidenceRefs, failingTests, upstream }`
     (structurally the merge-queue core's `EjectReason`) and an `error` evidence item.
3. `gittifacts-runner apply-resolution --patch <file> --onto <applyOnto>` → a resolution commit by
   `gittifacts-resolver` on top of the conflict commit. If it fails, `applyFailed(outcome, input, note)`
   turns the outcome into an ejection.
4. Re-evidence the merged tree, add the `conflict-resolution` item to the bundle, and classify with
   `reclassifyAfterResolution(previous, …)` from `@app/classifier`, so the lane can only stay or
   rise. Report `ResolutionResult` to the core: `newHeadSha`, `lane`, `outsideHunks =
   evidence.touchesOutsideConflictHunks`, `blamedUpstream = semanticConflictWith`.

## Not the author

- Principal `system:resolver` (`RESOLVER_PRINCIPAL_ID`), not configurable. It refuses (`self-resolution`)
  if that principal is in `excludePrincipals`.
- Separate context: the prompt input type has no field for the author's summary, claim or agent
  trace, and the resolver copies only `id`, `title` and the SHAs of the Change. A test passes a
  full Change with a sentinel summary and checks it never reaches a request.
- Everything inside the data sections is marked as data; closing tags in data are neutralized.

## Prompt (`RESOLVER_PROMPT_VERSION`)

The system prompt states the job (keep both sides' intent; upstream is already accepted, never
undo it), how conflicts are shown (`<<<<<<<<<<<<< upstream · conflict N` / `||||||||||||| base` /
`=============` / `>>>>>>>>>>>>> change`), and the answer format, a JSON object checked by zod:

| Field | Meaning |
|---|---|
| `status` | `resolved`, `cannot-resolve` (needs an author decision: eject, no retry) or `not-a-conflict` (semantic only: no upstream Change explains the failure) |
| `regions` | `{ file, conflict, text }`: the lines replacing each whole region, markers excluded |
| `files` | `{ path, content \| null }`: whole files, only where an edit outside the regions is needed (or for semantic fixes); only files it was shown in full |
| `semanticConflictWith` | the blamed upstream changeId (must be a candidate); ignored for textual conflicts |
| `rationale` | two to four sentences |

The user prompt holds the Change's plan and diff, each upstream Change's plan and diff, the
conflicted files with numbered regions (whole-file conflicts show every side), the failing tests
and candidates for a semantic conflict, the optional context files, and a `<rules>` line with the
region count.

## Validation (nothing is taken from the model on trust)

An answer is rejected (and the model gets the list of problems for its **one** regeneration) when
it is not JSON, fails the schema, leaves a region unresolved or resolves one twice, names an
unknown file or region, edits a file it was not shown (or one shown abbreviated), leaves conflict
markers, repeats the clean line right outside a region, or (semantic) blames a non-candidate.
After two unusable answers the Change is ejected (`invalid-output`).

From a valid answer the resolver builds the resolved files (line endings and final newlines
normalized to the file's), writes the patch with `@app/evidence`'s diff writer and **verifies it
by applying it in memory**, and computes the scope with `resolutionScope`: `conflictHunks`,
`outsideHunks`, `touchesOutsideConflictHunks` and `novelLines` come from the merged text and the
resolved files, never from the model.

## Budget and failures

Same accounting as the reviewer (`@app/tour`'s `BudgetTracker`, price table, worst-case estimate
before every call, AI Gateway metadata `{ change_id, purpose: "resolve", head, attempt, prompt }`).
Diffs are fitted to what the budget can pay for (conflicts are never cut), reserving one
regeneration when possible.

| `cause` | `code` (merge queue) | When |
|---|---|---|
| `budget-exceeded` | `resolution-budget-exhausted` | the estimate does not fit, or the gateway refuses (429) |
| `invalid-output` | `textual-conflict` / `semantic-conflict` | two unusable answers |
| `model-unavailable` | same | two failed model calls |
| `declined` | same | the model answered `cannot-resolve` |
| `not-a-conflict` | `tests-failed` | semantic: no upstream Change explains the failure |
| `unsupported-conflict` | same as the mode | binary, over 512 KiB, or unparseable markers |
| `invalid-input` / `self-resolution` / `apply-failed` | same as the mode | bad merge document, excluded principal, `apply-resolution` failed |

`fix` is aimed at the authoring agent: `call: open_workspace({ changeId })`, `command: git fetch
origin && git rebase <onto>`, and an explanation naming the files, the upstream Changes (the blamed
one first) and the failing tests.

## Eval

`fixtures/conflicts/` holds 11 textual and 3 semantic cases (see its README). `pnpm test` runs all
of them through the real runner, the resolver (with a scripted model answering the known-correct
resolution), `apply-resolution` and the cases' expected-behaviour tests, and asserts zero lane
downgrades. `pnpm --filter @app/resolver eval` runs the same pipeline with a real model through AI
Gateway (not part of `pnpm test`) and reports the success rate (gate: ≥ 80% on textual conflicts)
and lane downgrades (gate: 0).
