# Merge-queue scenarios

Small multi-change repositories for the agent-native merge queue
(`docs/prompts/03-merge-queue.md`). Each scenario is one base tree plus several **Changes**,
with what the queue must conclude about them: each Change's `AffectedSet`
(`@app/affected`), the pairwise conflict matrix, which combinations git can merge, and which
combinations pass their tests.

Like the other fixtures, these are not workspace packages and are never installed. Tests run
with the monorepo's vitest through a symlinked `node_modules`.

## Layout

```
fixtures/queue/
  _base/                         shared base tree (below)
  <scenario>/
    scenario.json                changes + expectations
    base/                        optional overlay on _base (e.g. the flaky test)
    changes/<id>/                whole-file overlay forming Change <id>
    changes/<id>.deleted.txt     optional: paths Change <id> deletes (# comments ok)
```

## Materializing

```ts
import { materializeQueueScenario } from "../scripts/lib/fixtures.js";

const { dir, baseSha, changes, scenario } = await materializeQueueScenario("semantic-conflict", { outDir });
// dir = <outDir>/semantic-conflict (default outDir: fixtures/.materialized/queue)
// changes.a = { branch: "change/a", sha, parentSha }
```

Each run creates a fresh repository:

- The base (`_base` plus the scenario's `base/`) is committed on `main`.
- Each Change gets a branch `change/<id>`, created from `main`, or from its `dependsOn` Change
  for stacks. The overlay is applied and the deletions are removed.
- `main` is checked out at the end.

Identities and dates are fixed (as for the other fixtures), so SHAs are stable. A Change's
affected set is computed against `parentSha`: main's base for most Changes, the parent's head for
a stacked Change.

## The base tree

| Package | Files | Notes |
|---|---|---|
| `@queue/money` | `src/round.ts` ← `src/format.ts` ← `src/index.ts` (barrel) | `exports: { ".": "./src/index.ts" }` |
| `@queue/text` | `src/slug.ts`, `src/title.ts` | Subpath exports `./slug`, `./title`, and no barrel |
| `@queue/api` | `src/worker.ts` → `src/routes/price.ts` → `@queue/money` | The `queue-api` Worker (`wrangler.jsonc`) |

There are 6 test files and 8 tests. `packages/text/test/headline.test.ts` imports both text
modules, so it's the shared test target. `vitest.config.ts` aliases the workspace packages to
their sources; aliases aren't setup files, so they don't make every test depend on them.

## Scenarios and their conflict matrices

Conflict reasons come from `conflictBetween` in `@app/affected`:

| Reason | Meaning |
|---|---|
| `incomplete` | Either set is incomplete |
| `config` | Either set contains `*config*` |
| `files` | Shared touched files |
| `modules` | Overlapping module sets |
| `tests` | Shared test targets (`*` meets any non-empty set) |

`—` means independent: the two Changes can advance in parallel tracks.

| Scenario | Changes | Conflicts | git merge | Tests |
|---|---|---|---|---|
| `independent` | **a** slugify trims dashes · **b** `roundCents(amount, mode)` (public API) · **c** README | a/b —, a/c —, b/c — | a+b+c clean | everything passes |
| `textual-conflict` | **a** thousands separators · **b** currency symbols, both in the same lines of `format.ts` and its test | a/b `files modules tests` | a+b **conflicts** | each passes alone |
| `overlapping-closure` | **a** banker's rounding in `round.ts` · **b** accounting negatives in `format.ts` (which imports `round.ts`) | a/b `modules tests` | clean | each and a+b pass |
| `shared-test-only` | **a** slugify · **b** titleCase acronyms. The closures are disjoint, and both reach `headline.test.ts` | a/b `tests` | clean | a+b passes |
| `stack` | **a** `clampCents` + barrel re-export (public API) · **b** (on a) clamps prices in the route | a/b `modules tests` | clean | a, and b (which contains a), pass |
| `semantic-conflict` | **a** `formatCents` → `"€3.50"` (tests updated) · **b** new invoice route + test expecting `"3.50 EUR"` | a/b `modules` | clean | a passes, b passes, **a+b fails** `invoice.test.ts` |
| `flaky-test` | main has `flaky.test.ts` (~20% failures) · **a** titleCase (the flaky test is in its targets) · **b** currency code upper-cased | a/b — | clean | seed 1–6 pass, 7–9 fail, on main and with a |

### Notes

- **semantic-conflict**
  - a's closure is computed on a's tree, so it never contains b's new file. Each set alone
    would look independent.
  - They still conflict on `modules`. b *adds* an import edge to `@queue/money`'s barrel, and
    `modules` includes the targets of edges a Change adds. a's reverse-dependency closure contains
    that barrel.
  - Without that rule the two Changes would land in parallel tracks. Only the revalidation of the
    second one (its `invoice.test.ts` is in its own targets) would catch the conflict. With the
    rule they share a track, and batch bisection finds b as the culprit, with a as the upstream
    cause.
- **flaky-test**
  - `QUEUE_FLAKE_SEED` makes the outcome a pure function of the seed (mulberry32, first draw
    < 0.2 fails). `scenario.json` lists `failingSeeds` and `passingSeeds`.
  - Without the variable it uses `Math.random()`.
  - A queue test can force "fails in the batch *and* on main's head" (suspected flaky,
    quarantine, don't eject) or "passes on main's head" (real failure, bisect).
- **textual-conflict** is the resolver's input. The intended resolution keeps both features
  (`"€1,234.50"`).

## scenario.json

```jsonc
{
  "name": "semantic-conflict",                 // = directory name
  "description": "…",
  "changes": [
    { "id": "a", "title": "…", "dependsOn": null },
    { "id": "b", "title": "…", "dependsOn": "a" }   // stacked: branched from change/a
  ],
  "flaky": {                                    // optional
    "test": "packages/text/test/flaky.test.ts", "env": "QUEUE_FLAKE_SEED", "rate": 0.2,
    "failingSeeds": [7, 8, 9], "passingSeeds": [1, 2, 3]
  },
  "expected": {
    "affected": {                               // every change; analyzer reports not compared
      "a": { "files": [], "modules": [], "testTargets": [], "publicApi": false, "deploysTo": [], "complete": true }
    },
    "conflicts": [{ "pair": ["a", "b"], "reasons": ["modules"] }],   // EVERY pair; [] = independent
    "merges": [{ "changes": ["a", "b"], "clean": true }],             // folded onto main with merge-tree
    "outcomes": [                                                     // vitest on main + changes
      { "changes": ["a", "b"], "env": { "QUEUE_FLAKE_SEED": "7" }, "pass": false, "failing": ["…test.ts"] }
    ]
  }
}
```

`packages/affected/test/queue-fixtures.test.ts` checks all of it. It materializes every
scenario, computes each Change's `AffectedSet` from git, and compares fields and conflict
reasons exactly. It checks merges with `git merge-tree --write-tree` and runs vitest on merged
worktrees. Set `SKIP_QUEUE_RUNS=1` to skip the vitest runs.

## Adding a scenario

1. Create `fixtures/queue/<name>/scenario.json` and `changes/<id>/` overlays. Add a `base/`
   overlay if the scenario needs extra base files.
2. Run `pnpm --filter @app/affected test -- queue-fixtures`. A mismatch prints the computed
   set.
3. Changing `_base` changes every scenario's SHAs and possibly their affected sets.
