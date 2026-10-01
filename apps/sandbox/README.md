# @app/sandbox — the CI sandbox image and `gittifacts-runner`

`gittifacts-runner` runs inside the CI container and measures a change. It does not judge it
(that is `@app/classifier`). When it can't measure something, it says so (`status: "error"` or
`"skipped"` with a note). It never reports a guess as `"ok"`.

## Build and run

```sh
pnpm --filter @app/sandbox build                       # → dist/gittifacts-runner.mjs (+ dist/package.json)
docker build -f apps/sandbox/Dockerfile -t gittifacts-sandbox .   # from the repo root, or:
docker build -t gittifacts-sandbox apps/sandbox                    # wrangler's build_context "../sandbox"
docker run --rm gittifacts-sandbox gittifacts-runner --help
```

Both contexts produce the same image. `Dockerfile.dockerignore` limits either context to
`dist/` and `image/`, about 1 MB.

## Commands and output

| Command | stdout (one line, the last) |
|---|---|
| `evidence <kind> --base <sha> --head <sha> [--package-manager pm] [--test-command '…']` | `::evidence::<EvidenceItem>` (`transforms` and `policy`: an array) |
| `policy --base <sha> [--head <sha>]` | `::evidence::<PolicyDocument>` (`src/commands/policy.ts`) |
| `plan [file] [--sha <sha>] [--base <sha>]` | `::plan::<PipelineSpec>`, or `::plan::{"error","file"}` |
| `diff --base <sha> --head <sha>` | `::evidence::<ChangeDiff>` |
| `preview [--port 8787] [--ip 0.0.0.0] [--dir dist] [--dry-run]` | `::preview::{status,kind,mode,command,url}` once the port answers; then it runs until wrangler exits |
| `merge-attempt --base <sha> --onto <sha> --head <sha>` | `::merge::{status: clean\|conflict\|error, files[], newSha \| conflictSha, markers, upstreamCommits, messages}` (`src/commands/merge.ts`) |
| `apply-resolution --patch <file> [--onto <sha>]` | `::merge::{status: resolved\|error, parentSha, newSha, files}` |
| `affected --base <sha> --head <sha> [--coverage-map <file>] [--public-api-evidence <file>]` | `::affected::<AffectedSet>` (`@app/affected`; not an EvidenceItem, hence its own marker) |
| `detect [--sha <sha>]` | `::detect::<DetectReport>` (`@app/conventions` `inspectRepo`; import detection, see below) |

- **Evidence kinds:** `red-green`, `coverage`, `mutation`, `public-api`, `dependencies`,
  `transforms`, `sensitive-paths`, `test-run`, and `policy`. `evidence policy` returns the
  base-policy sensitive-path item with id `policy:sensitive-paths`, so the CI evidence channel
  only ever carries EvidenceItems.
- **Defaults:** `--base` and `--head` fall back to `$GITTIFACTS_BASE_SHA` and
  `$GITTIFACTS_HEAD_SHA`. `--cwd` defaults to the current directory.
- **Output file:** `$GITTIFACTS_EVIDENCE_OUT` (or `--out`) also gets the JSON, with no prefix.
- **Logs** go to stderr.
- **Exit codes:**
  - 0 when a document was printed, including error items and `plan` error documents
  - 2 on a usage error
  - 1 on a crash, or when `preview` fails to start
- **Missing commits:** a commit that isn't in the checkout is fetched from `$GITTIFACTS_REMOTE`
  with `$GITTIFACTS_TOKEN`. The token goes through git's `GIT_CONFIG_*` env only. It is never in
  argv and never in logs, and it is scrubbed from every child process.

## Merge-queue jobs

Both commands work in a throwaway worktree, never move the checkout's `HEAD`, and print exit 0
with a `::merge::` document even when the job fails (`status: "error"`, with a `note`).

- **`merge-attempt`** replays the Change (`base..head`) as one commit onto `--onto` with an
  explicit merge base: it cherry-picks a synthetic commit (head's tree, parent `base`), because
  git 2.39 in the image has no `merge-tree --merge-base`. Commits below `--base` are never carried
  over.
  - **clean:** `newSha` is the replayed commit (parent `onto`, the head's author and message,
    committer `gittifacts`).
  - **conflict:** every conflicted path is listed with `kind` (`content`, `add-add`,
    `modify-delete`, `other`), `mode`, and the `base`, `ours` (upstream, `--onto`) and `theirs`
    (the Change, `--head`) contents. Content conflicts are re-merged with
    `git merge-file --diff3 --marker-size=13 -L upstream -L base -L change`, so
    `merged_with_markers` uses `<<<<<<<<<<<<< upstream`, `||||||||||||| base`, `=============`
    and `>>>>>>>>>>>>> change`. These markers are rare enough not to clash with file content, and
    `markers` in the document says so for parsers (`@app/evidence` `parseConflicts`). Whole-file
    conflicts keep the surviving side. Binary or over-512 KiB sides are not inlined (`binary`,
    `tooLarge`). `conflictSha` is a commit on `onto` whose tree holds those files;
    `upstreamCommits` are the commits in `base..onto` that touched a conflicted path.
  - Commits are deterministic: identities and dates come from the inputs, so a re-run in a fresh
    container reproduces the same SHAs.
- **`apply-resolution`** applies a resolution patch (`git apply --index`, the diff from the
  conflict commit to the resolved tree) on `--onto` (default `HEAD`, normally merge-attempt's
  `conflictSha`, or its `newSha` for a semantic conflict). It refuses when the patch does not
  apply or when any merge-attempt marker remains, and otherwise commits as
  `gittifacts-resolver <resolver@gittifacts.dev>` with a `Gittifacts-Resolver: system:resolver`
  trailer. The resolution is its own commit, so it stays attributable apart from the author's
  work.

## Affected sets (`affected`)

`affected` computes the Change's `AffectedSet` for the merge queue's conflict graph
(docs/prompts/03-merge-queue.md §4.1). The analysis is the pure `@app/affected` library. The
command only reads git objects: `ls-tree` of base and head, the name-status diff, and one
`cat-file --batch` for the files the analyzers read. The working tree can be anywhere. The
document is validated against the `AffectedSet` schema before it is printed.

```ts
AffectedSet = {
  files: string[];        // touched paths, both sides of renames, sorted
  modules: string[];      // touched files + their reverse-dependency closure (minus test files)
                          //   + targets of import edges the Change adds; may hold "*config*"
  testTargets: string[];  // test files covering the closure; ["*"] = all tests
  publicApi: boolean;     // an exported signature reachable from a package entry changed
  deploysTo: string[];    // wrangler `name`s of Workers whose package the Change reaches
  complete: boolean;      // false ⇒ the queue treats it as conflicting with everything
  analyzers: { name; version; complete; note? }[];   // complete = every analyzer complete
}
```

- **Module graph.** A tolerant scanner, without the TS compiler, reads every module-like file:
  - JS/TS: `import`/`export … from`, `import()`, `require`, `import.meta.glob`,
    `new URL(…, import.meta.url)`, `vi.mock`, and triple-slash references;
  - Vue, Svelte, Astro and MDX components;
  - HTML `src`/`href` attributes;
  - CSS `@import` and `url()`.

  Specifiers resolve with TypeScript's extension rules, tsconfig `paths`/`baseUrl` (following
  `extends`), and package.json `imports`. Workspace packages resolve by name through `exports`
  (all conditions, `*` patterns) or `main`, and build outputs such as `dist/x.js` map back to
  `src`. A computed specifier with a static relative prefix, like `` import(`./locales/${l}.json`) ``,
  becomes a glob.
- **New edges.** `modules` also holds the targets of import edges the Change *adds*. A new
  caller of an existing module then overlaps Changes to that module. Without this, the
  `semantic-conflict` fixture would look independent: each Change's closure is computed on its
  own tree.
- **`*config*`.** A Change to any of the following puts `*config*` in `modules` and sets
  `testTargets: ["*"]`; `complete` stays true:
  - manifests and lockfiles;
  - tsconfig;
  - test-runner, bundler and lint configs;
  - wrangler configs and Dockerfiles;
  - anything under `.platform/`.

  The core must treat `*config*` as conflicting with everything. `deploysTo` gets every Worker
  under the config's directory, or every Worker the package's closure reaches. A root config
  deploys all of them, except lint, test-runner and CI configs.
- **Test impact.**
  - With `--coverage-map`, the targets are the tests that executed a touched file on main's
    last full run. On top of that come touched tests, and static selection for touched files
    no test executed (new files, data files) and for test files the map doesn't list.
  - Without a map, the targets are the test files whose import closure meets the Change.
  - When the set is incomplete or config changed, the targets are `["*"]`, with the reason in
    the `test-impact` note.
  - A setup file that a runner config loads (`setupFiles`, `globalSetup`) selects every test
    under that config.
  - Map shapes:
    - `{ "<test>": ["<file>", …] }`;
    - `{ "<test>": <istanbul coverage-final.json> }` (a file counts as covered when any counter
      is above 0);
    - `{ "format": "gittifacts.coverage-map", "version": 1, "commit", "root", "tests": … }`.

    Paths may be absolute: the checkout root is stripped, and other paths are matched by a
    unique suffix. An unreadable map is noted, and static selection is used instead.
    `$GITTIFACTS_COVERAGE_MAP` is the default for the flag.
- **`publicApi`.**
  - `--public-api-evidence` takes the verdict from an `ok` public-api item (`classification`
    other than `none`).
  - Otherwise a cheap exported-signature diff decides. It looks at touched code files reachable
    from any package entry point. Each export's declaration text is compared, normalized, with
    function bodies dropped. Package.json entry fields (`exports`/`main`/`types`/…) count as well.
- **`deploysTo`.**
  - Workers come from every `wrangler.{jsonc,json,toml}` outside test-support directories.
  - A Worker is included when the Change's modules reach a non-test file in its package.
  - It is also included when the Change touches its config or its assets. A build-output
    assets directory, such as `../web/dist`, counts as the package that builds it.
  - A container image's build context (`containers[].image`, `images.*.build_context` or
    `dockerfile`) counts too: the platform Worker ships this runner from `../sandbox`.
- **`complete: false`** in any of these cases:
  - a touched file has no analyzer that understands its dependents (data read with `fs`, shell
    scripts, unknown types; docs, metadata, configs, snapshots and Worker assets are understood);
  - the closure reaches a package with unresolvable references (an unmapped local package
    entry, or an unresolved `@/` or `~/` alias);
  - an analyzer crashed, or a scanned file was unreadable;
  - a wrangler config has no `name`;
  - the checkout or the analysis failed.

  An incomplete document still carries what is known, escalated: `["*"]`, `publicApi: true`,
  and every known Worker. When nothing could be computed it lists only the touched files, with
  `analyzers: [{ name: "gittifacts-runner", complete: false, note }]`.
- **Cost.** On this monorepo (≈810 files, ≈630 scanned, ≈4 MB of source), the whole command
  takes about 1.2 s: reading the blobs ≈0.4 s, the analysis ≈0.4 s cold, and node startup.

## Import detection (`detect`)

`detect` describes an imported repository so the platform can propose its `.platform/ci.ts`,
`.platform/policy.ts` and `AGENTS.md` as a Plan + Change that a human approves. The analysis is the
pure `@app/conventions` `inspectRepo`; the command lists the tracked files (`git ls-files`, or a
walk that skips `node_modules`/`dist` outside git) and reads them. Nothing is installed or run,
so it works with `--network none`.

- **Output.** `DetectReport` (schema in `@app/conventions`): `features` and `confidence` from
  `detectProject`, `uncertain[]` (one sentence per guess, each becomes a Plan risk),
  `packageManager`, `testRunner` (refined from vitest/jest configs when the test script doesn't
  name it), the install/test/build/typecheck/lint commands, `tsconfig` (`strict`, `extends`,
  project references), `workers` (the `name` of every wrangler config outside test fixtures),
  `workspaces`, and `buildScriptsNeedingApproval`.
- **pnpm 11 build scripts.** pnpm refuses to install (`ERR_PNPM_IGNORED_BUILDS`) while a
  dependency's install script is not approved in `pnpm-workspace.yaml` `allowBuilds` (or
  `onlyBuiltDependencies`). pnpm lockfiles don't record install scripts, so the candidates are the
  lockfile's packages that are on a list of well-known install-script packages, minus approved
  and denied ones; `uncertain` says the list may be incomplete. npm lockfiles record
  `hasInstallScript`, which goes into `notes` (npm runs them). Detection never approves anything.
- **Fail closed.** A crash still prints a document: `confidence: "low"` and the failure as the
  first `uncertain` sentence.

## How each signal is measured

- **red-green.**
  1. The new or changed test files are read from the diff. Within them, the changed test
     cases are found from the syntax tree plus the diff lines. The whole file is used when that
     can't be decided: a dynamic title, or top-level setup code.
  2. Those files are run at head with the repo's own vitest or jest binary and a JSON reporter.
  3. They are run again in a clean `git worktree` of base, with head's test and test-support
     files overlaid.
  4. Base dependencies are head's `node_modules`, symlinked, when the dependency graph is
     identical (lockfiles, install config, and the dependency fields of every manifest).
     Otherwise the base is installed. If that install fails, the item is an error, because a
     red result on a broken base proves nothing.
  5. A test that is absent on base, or whose file can't load there, is `missing`.
- **coverage.**
  - The whole suite runs once with `include` set to the changed source files, so an unloaded
    changed file counts as uncovered instead of being absent from the report.
  - vitest uses `--coverage.provider=v8`. vitest imports `@vitest/coverage-v8` **by name, in
    workers too**, from its own location, so a `customProviderModule` path is not enough.
  - If the repo's vitest can't resolve the package, the runner symlinks its own copy into
    `<checkout>/node_modules/@vitest/coverage-v8` for the run and removes it afterwards. In npm,
    yarn and pnpm layouts, the lookup from vitest's real path walks up to that directory.
  - A non-zero exit where every test passed is an error (for example a provider crash), never
    0%.
- **mutation.**
  - Uses the runner's own Stryker (`@stryker-mutator/core` bin). The vitest runner plugin is
    loaded by absolute path (`plugins: [<abs>]`), and the plugin uses the repo's vitest.
  - `mutate` is set to the changed line ranges (`file:start-end`). `coverageAnalysis` is
    `perTest`.
  - Concurrency is capped by cgroup CPUs, by memory (768 MiB per worker) and by the number of
    changed lines.
  - The score comes from the pure producer: only mutants on changed lines count.
  - If nothing could be mutated, the item is `skipped` with score 0.
- **public-api.** Applies to each package entry point: `exports` conditions or `types`, mapped
  back to the source through tsconfig `outDir`/`rootDir`, or `src/index.ts`.
  - Declarations are emitted in memory (`emitDeclarationOnly`).
  - The entry `.d.ts` is loaded in a second program, and `getExportsOfModule` follows the
    re-exports.
  - Each export is described with `signatureToString`/`typeToString` using fixed flags.
  - Base runs in a worktree that uses head's `node_modules` for type resolution.
  - The result goes to `diffApiSurface`.
- **dependencies.** Every `package.json` at base and head is read from git objects. The
  lockfile flag comes from the touched paths.
- **transforms.**
  - Each script under `.platform/transforms/` **at base** runs on a clean base worktree
    (`.mjs`/`.js`/`.cjs` with node, `.ts` with type stripping, `.sh` with sh).
  - It gets head's `node_modules` only when the dependency graph is identical; otherwise it runs
    with none.
  - The produced tree is compared with head by blob id.
  - The result is verified only when every file the script rewrites matches head. Files left at
    their base content count as mismatches.
  - A script whose output appears nowhere in head is `skipped`.
- **policy.** `.platform/policy.ts` at **base** is bundled straight from git objects with
  esbuild. Relative imports are followed, and `definePolicy` is shimmed. The bundle is imported
  in a child process with a timeout and validated with `RepoPolicy`.
- **plan.** `.platform/ci.ts` is bundled with esbuild and recorded by the ci-engine recorder in
  a child process with a timeout. Without a file, `defaultPipeline()` is used.

Measured source excludes tests and test support files, `.d.ts`, `*.config.*`, `.platform/`
and `.github/`.

## Image

| Path | Contents |
|---|---|
| `/opt/gittifacts-runner` | Bundle, TypeScript, esbuild, Stryker, coverage-v8 and vitest (peer) |
| `/opt/wrangler` | wrangler 4.145.0 and workerd |
| `/opt/corepack` | Pre-fetched pnpm 11.27.0 and yarn 1.22.22 |

- **User and paths:** user `runner` (uid 10001), workdir `/workspace`, `tini` +
  `sleep infinity`.
- **Stable caches** (reusable through snapshots): `/opt/pnpm-store`, `/opt/npm-cache` and
  `/opt/yarn-cache`.
- **Wrappers:** every entry point in `/usr/local/bin` (pnpm, pnpx, yarn, npm, npx, corepack,
  wrangler, gittifacts-runner, git) is a wrapper that sources `/opt/gittifacts/env.sh` first. The
  Runner DO execs steps with a minimal env (PATH, `HOME=/root`, …), so image `ENV` doesn't reach
  them. `env.sh` only sets defaults: store and cache paths, `COREPACK_HOME`, telemetry and
  update checks off, and a writable `HOME`.
- **Registries:** not pinned. Set `npm_config_registry`, `YARN_NPM_REGISTRY_SERVER` or
  `COREPACK_NPM_REGISTRY` to go through a proxy.
- **Network:** the runner, wrangler builds and previews work with `--network none`. Only
  package installs need the registry.
