# Fixture repositories

Small, real repositories used by integration tests. Each fixture describes one **Change**
(base commit → head commit) plus the claim, the approved Plan, and what the platform should
conclude about it: lane, reason codes and key evidence facts. The code is real. Tests pass and
fail as described, `tsc` emits declarations, and the codemod reproduces its output byte for byte.
`pnpm tsx scripts/check-fixtures.ts` checks all of that.

Fixtures are **not** workspace packages: they live outside `packages/` and `apps/`, Biome
ignores them, and they are never `pnpm install`ed. Tests run against the monorepo's installed
vitest 4.1.11 and TypeScript 6.0.3 (the fixture `package.json` pins the same versions).

## Layout

```
fixtures/
  _base/                      shared starting tree: the @fixture/lib library (see below)
  <name>/
    fixture.json              claim, plan, expectations
    head/                     overlay: files written over the base to form the head commit
    base/                     optional overlay applied to _base to form this fixture's base
    deleted.txt               optional: repo-relative paths deleted at head (# comments ok)
  .materialized/              output of the materializer (gitignored)
```

Overlays hold whole files, not patches. A file in `head/` replaces (or adds) the file at the
same path. File modes are normalized to 0644 (0755 if the overlay file is executable).

### fixture.json

```jsonc
{
  "name": "pure-bugfix-with-regression-test",      // must equal the directory name
  "description": "…",
  "claim": { "category": "fix", "title": "…" },    // ClaimedCategory from @app/domain
  "transform": {                                    // only for transform fixtures
    "script": ".platform/transforms/rename-helper.mjs",
    "command": "node .platform/transforms/rename-helper.mjs",  // run from the repo root
    "source": "base"                                // which commit the script is taken from
  },
  "plan": {                                         // PlanDraftInput fields + approval
    "title": "…", "intent": "…",
    "acceptanceCriteria": ["…"], "outOfScope": ["…"],
    "riskDeclarations": [{ "area": "…", "description": "…" }],
    "scopePaths": ["src/allocate.ts", "test/allocate.test.ts"],   // globs
    "affectedRoutes": [],
    "approved": true
  },
  "expected": {
    "computedLane": 0,              // classifier lane before shadow mode
    "laneWithShadow": 1,            // routed lane under the base policy (lane0Enabled: false)
    "requiresHumanApproval": false, // true iff something under .platform/ changed
    "reasonCodes": ["red-green.proven", "shadow.lane0-disabled"],  // MUST appear (others may)
    "evidence": {                   // every key optional
      "changedFiles": ["src/allocate.ts", "test/allocate.test.ts"],
      "redGreen": "proven",         // proven | not-proven | no-tests
      "failingOnBase": ["test/allocate.test.ts > allocate > hands leftover minor units to the first shares"],
      "publicApi": "none",          // none | additive | breaking (exports of dist/index.d.ts)
      "apiAdded": [], "apiChanged": [], "apiRemoved": [],
      "dependenciesAdded": [], "dependenciesRemoved": [], "lockfileChanged": false,
      "sensitiveHits": [],          // changed paths matching the BASE policy's sensitivePaths
      "scopeDrift": [],             // changed paths matching none of plan.scopePaths
      "policyChanged": false,       // .platform/policy.ts changed
      "transformVerified": true     // transform re-run on base reproduces head's tree
    }
  }
}
```

`reasonCodes` use names from `packages/classifier/src/reasons.ts` (`REASON_CODES`).
The classifier returns every reason, including passing ones such as `red-green.proven`, so a
fixture lists the codes that decide its lane. Test ids in `failingOnBase` are
`<file> > <describe…> > <test name>`.

## Materializing

```sh
pnpm fixtures:materialize                     # all → fixtures/.materialized/<name>
pnpm fixtures:materialize scope-drift touches-auth
pnpm fixtures:materialize --out /tmp/fx       # → /tmp/fx/<name>
```

```ts
import { materializeFixture } from "../scripts/lib/fixtures.js";

const { dir, baseSha, headSha, fixture } = await materializeFixture("scope-drift", { outDir });
// dir = <outDir>/scope-drift; outDir defaults to fixtures/.materialized
```

Each run creates a fresh repo: `_base` (plus `base/`) committed on `main`, then the head
overlay (minus `deleted.txt`) committed on branch `change`, which stays checked out. Git runs
with an isolated config (`GIT_CONFIG_GLOBAL=/dev/null`, no signing or hooks) and fixed
identities and dates: base by *Fixture Maintainer* at 2026-01-01T09:00Z, head by
*Fixture Agent* at 2026-01-02T09:00Z. That makes SHAs stable across runs and machines. All
fixtures without a `base/` overlay share one base commit.

To run a fixture's tests or build without installing anything, link the monorepo's
`node_modules` into the checkout (the fixture `.gitignore` ignores `node_modules` even as a
symlink) and use the root binaries:

```sh
ln -s "$ROOT/node_modules" "$DIR/node_modules"
node "$ROOT/node_modules/vitest/vitest.mjs" run --root "$DIR"
(cd "$DIR" && node "$ROOT/node_modules/typescript/bin/tsc" -p tsconfig.json)   # → dist/*.d.ts
```

## Verification

`pnpm tsx scripts/check-fixtures.ts [names…] [--jobs N] [--verbose]` materializes each
fixture, checks out base and head as worktrees under `fixtures/.materialized/.check/<name>/`,
and asserts:

- `fixture.json` is valid (Plan bounds mirror `@app/domain`). `.platform/policy.ts` at base
  and at head parses as a `RepoPolicy` with no unknown keys, and the base keeps
  `lane0Enabled: false`.
- `tsc -p tsconfig.json` emits `dist/index.d.ts` at base and head, and `src` + `test`
  type-check together on both sides.
- Every test passes at base and at head.
- Red/green: head's added or modified test files are copied onto a base checkout and run
  there. The verdict and the failing tests must match `redGreen` and `failingOnBase`.
- The exports of `dist/index.d.ts` (read with the TypeScript checker) are diffed between base
  and head. The result must match `publicApi`, `apiAdded`, `apiChanged` and `apiRemoved`.
- Changed files, the dependency diff, sensitive-path hits (base policy globs), scope drift
  (plan globs) and the policy change match the expectations.
- Transforms: the command is run on a clean base checkout, `git write-tree` of the result
  must equal head's tree, and re-running the command on head must be a no-op.
- `reasonCodes`, `laneWithShadow` and `requiresHumanApproval` are consistent with the measured
  facts. A Lane 0 expectation must rest on a proven red/green or a verified transform.

Changed-line coverage and mutation score are not measured here. They need
`@vitest/coverage-v8` and Stryker, which are not installed at the root. The fixtures are
written to do well on both: the changed lines are exercised and the boundary tests kill the
obvious mutants.

## The base library: `@fixture/lib`

Integer-cents money helpers plus HMAC-signed session tokens. ESM, `tsc` → `dist/` with
declarations. Public API = the exports of `src/index.ts`:

| Module | Exports |
|---|---|
| `src/money.ts` | `CurrencyCode`, `Money`, `money(amount, currency)`, `add`, `subtract` |
| `src/allocate.ts` | `allocate(total, ratios)`: proportional split, leftover units to the first shares |
| `src/format.ts` | `formatMoney(value)` → `"1234.56 EUR"`, `parseMoney(text)` |
| `src/auth/token.ts` | `TokenClaims`, `signToken(claims, secret)`, `verifyToken(token, secret, now?)` (Web Crypto HMAC-SHA256) |
| `src/internal/currency.ts` | *internal, not re-exported*: `requireCurrency`, `minorDigits`, `assertSameCurrency` |

There are 41 tests in `test/{money,allocate,format,auth}.test.ts`. `.platform/policy.ts` is a
plain object literal (shadow mode, default sensitive paths including `**/auth/**` and
`.platform/**`, default thresholds). `.platform/ci.ts` is a self-contained pipeline:
`install` → (`lint` ∥ `typecheck` ∥ `test`) → `build`.

**Seeded bugs** that the base tests do not catch:

1. `allocate()` hands out leftover minor units with `index < leftover - 1`, so whenever the
   total does not divide evenly one unit is lost: `allocate(money(100, "EUR"), [1, 1, 1])`
   returns 33/33/33. The base tests only use evenly divisible totals. Used by the two bug-fix
   fixtures.
2. `verifyToken()` rejects with `exp < now`, so a token is still accepted during its expiry
   second (RFC 7519 says "on or after"). No base test hits `now === exp`. Used by
   `touches-auth`.

## Fixtures

| Fixture | Claim | Diff | Lane (computed → routed) | Must-have reason codes | Key evidence |
|---|---|---|---|---|---|
| `pure-bugfix-with-regression-test` | fix | `allocate.ts` one-line fix + 2 regression tests | 0 → 1 | `red-green.proven`, `shadow.lane0-disabled` | red/green proven (2 tests red on base), API none, in scope |
| `bugfix-without-test` | fix | the same one-line fix, no test change | 2 → 2 | `red-green.no-tests` | red/green `no-tests`; all tests green on both sides |
| `additive-api` | feature | new `multiply()` in `money.ts`, re-exported, README row, 6 tests | 1 → 1 | `api.additive` | API additive, added `multiply`; red/green proven |
| `breaking-api` | feature | `formatMoney(value)` → `formatMoney(value, options)` (required `FormatOptions`), tests + README updated | 2 → 2 | `api.breaking` | API breaking, changed `formatMoney`, added `FormatOptions` |
| `new-dependency` | dependency | `package.json` gains `dependencies.nanoid: ^5.1.5`, `pnpm-lock.yaml` the matching entry, nothing else | 2 → 2 | `dependency.added` | added `nanoid`, lockfile changed |
| `touches-auth` | fix | `exp < now` → `exp <= now` in `src/auth/token.ts` + boundary test | 2 → 2 | `red-green.proven`, `sensitive.hit` | sensitive hit `src/auth/token.ts`; otherwise Lane 0 quality |
| `codemod-rename` | transform | `requireCurrency` → `toCurrencyCode` in 3 `src/` files, generated by the codemod | 0 → 1 | `transform.verified`, `shadow.lane0-disabled` | transform verified byte-for-byte; API none; red/green `no-tests` |
| `policy-change` | chore | `.platform/policy.ts`: `changedLineCoverage` 0.8 → 0.5 | 2 → 2, human approval | `policy.changed`, `sensitive.hit` | policy changed; sensitive hit `.platform/policy.ts` |
| `scope-drift` | feature | `parseMoney` accepts `1,234.56 EUR` (in scope, tested) **and** `money()` normalizes `-0` in `src/money.ts` (outside scope) | 2 → 2 | `scope.drift` | drift `src/money.ts`; red/green proven |

Notes on individual fixtures:

- **pure-bugfix-with-regression-test / bugfix-without-test** use the same plan. The second
  shows a fix whose tests pass on both sides but prove nothing.
- **touches-auth** is a perfect Lane 0 change in every other respect, so it isolates the
  sensitive-path rule.
- **breaking-api**: the breaking export is identified by name (`formatMoney`) in the `.d.ts`
  diff. Its new symbol-style tests fail on base because base ignores the extra argument.
- **new-dependency** changes only the manifest and the lockfile. The local fixture checks
  reuse the monorepo's root `node_modules`, where `nanoid` is not resolvable, so any import
  of it fails there. Even a type-only import or `/// <reference types>` would fail `tsc` with
  TS2307. `_base` carries a `pnpm-lock.yaml` (generated with pnpm 11.27.0, the sandbox's)
  because the fixture CI installs with `--frozen-lockfile`, as it does on the live GitHub test
  repo; this head adds nanoid's entry, so `lockfileChanged` is true.
- **policy-change**: policy is read from the BASE, so the lowered threshold does not govern this
  change. Any change under `.platform/` is Lane 2 and needs approval from someone other than
  the author.
- **scope-drift**: the out-of-scope edit is harmless and every test passes, so the drift is
  the only thing that makes it Lane 2.

### Transforms: where the script comes from

In `codemod-rename` the transform script `.platform/transforms/rename-helper.mjs` is **already
in the base** (the fixture's `base/` overlay). Assume it landed earlier through its own
human-reviewed change. The head diff contains only the script's output. The platform runs the
**base's** copy of the script on a clean base checkout and compares the result with head.

This is the opposite of putting the script in head. A script that arrives in the same change
it "reproduces" proves nothing: it could just write head's files out verbatim, so "verified"
would be vacuous. Adding or editing a file under `.platform/` is also `policy.changed` (Lane 2)
in the classifier. Taking the script from base follows the same rule as the policy
(*read from the base, never the head*) and splits the work into two steps. Humans approve the
codemod once, which is the intent. The machine then proves that each application of it conforms.

`fixture.json` records this as `"transform": { …, "source": "base" }`. The materializer and
checker also support `"source": "head"` (the script is taken from the head commit and run on
base), for fixtures that want to exercise that path.

The codemod is plain Node with no dependencies. It visits `*.ts` under `src/` and `test/` in
sorted order, replaces whole words only, rewrites a file only when its content changes, refuses
to run if both names already exist, and is idempotent.

## Adding a fixture

1. Create `fixtures/<name>/fixture.json` and a `head/` overlay (plus `base/` or `deleted.txt` if
   needed). Generated outputs such as codemod results should be produced by running the
   generator, not written by hand.
2. Run `pnpm tsx scripts/check-fixtures.ts <name> --verbose` until it passes. Measured values
   for keys you did not set are printed as `(no expectation)`.
3. Note that changing `_base` changes every fixture's base and head SHAs.
