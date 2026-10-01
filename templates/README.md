# Launch templates

`create_project({ template })` copies one of these into a new Artifacts repo. Each one passes CI and serves a
preview the moment it is created (north star: time-to-first-green under 60 s).

| id | What it is | Preview |
|---|---|---|
| `workers-api` | JSON API on Workers: `GET /` → `{ now }`, `GET /health` | `/`, `/health` |
| `preact-app` | Preact + `@preact/signals` SPA on Workers static assets, API under `/api/*` | `/`, `/api/time` |
| `ts-library` | npm library: Vitest, `tsc` emits `.d.ts`, `exports`/`types` set, so the public-API diff works | none (see below) |
| `static-site` | Plain HTML/CSS on Workers static assets; tests check titles and links | `/`, `/about/` |

## Layout of a template

- Source, `test/` (Vitest, node environment, no DOM or workerd needed), `package.json` with `lint`, `typecheck`,
  `test` and `build` scripts.
- `pnpm-lock.yaml` and `pnpm-workspace.yaml`: each template is a **standalone pnpm project**, not part of the
  monorepo workspace (the root `pnpm-workspace.yaml` lists only `packages/*` and `apps/*`). The template's own
  `pnpm-workspace.yaml` holds pnpm 11 settings: pnpm 11 fails an install that has unapproved build scripts
  (`ERR_PNPM_IGNORED_BUILDS`), so templates using esbuild allow its postinstall. Regenerate a lockfile with
  `pnpm install --lockfile-only` inside the template directory.
- `wrangler.jsonc` (Worker templates): `name` is `{{projectName}}`, `compatibility_date` is 2026-09-30, `main`
  points at the **build output**, and `build.command` runs `pnpm run build` so `wrangler dev` works from a clean
  checkout.
- `template.json`, `.platform/ci.ts`, `.platform/policy.ts` and `AGENTS.md` are **generated** by `@app/conventions`.
  Don't edit them by hand: change the generator and run `pnpm --filter @app/conventions sync-templates`. A test
  in `@app/conventions` fails when they drift. `AGENTS.md` here is rendered with placeholders and is rewritten
  with real values at create time.
- `README.md`: short, with `{{projectName}}`.

## Placeholders

`{{projectName}}`, `{{host}}`, `{{mcpUrl}}` and `{{repoId}}` appear in `wrangler.jsonc`, HTML titles, READMEs and
`AGENTS.md`. At create time the platform renders every text file with `renderPlaceholders()` (unknown `{{...}}`
is left alone), using `projectSlug(name)` for `projectName` so it is a valid Worker name, then writes the
generated files from `templateGeneratedFiles(id, {...})` on top.

## Assumptions the platform must meet

- **wrangler is not a template dependency.** With workerd and miniflare it is ~170 MB unpacked (workerd for
  linux-x64 alone is 135 MB), which would dominate install time. The sandbox image provides a global
  `wrangler` (4.145.0) and its workerd for previews; `template.json` `previewCommand`
  (`wrangler dev --ip 0.0.0.0 --port $PORT`) runs from the CI build snapshot, where `node_modules` and `dist/`
  exist. Agents developing locally use `npx wrangler dev`.
- **Build = esbuild (Worker templates), `tsc` (library), a file copy (static site).** esbuild bundles
  `workers-api` in ~0.1 s against ~1.3 s for `wrangler deploy --dry-run --outdir dist` (measured on the same
  project, warm), needs no global tool, and runs the same command locally, in CI and inside `wrangler dev`.
  It costs one ~11 MB devDependency (esbuild and its platform binary) that the dependency snapshot caches.
  The library needs `tsc` anyway for declarations. When the platform later uploads a production version,
  `wrangler deploy --dry-run` bundles the already-built `main`.
- **`ts-library` has no preview** (`previewCommand: null`): a library has no runtime to serve. Its first green
  is CI plus the public-API diff. If every template must have a live URL, the platform could serve generated
  API docs; that is not built.
- **Preview gateway:** `wrangler dev` serves `/cdn-cgi/local/explorer/api` (local storage and trace explorer) on
  the same port. The preview gateway must block `/cdn-cgi/*` before proxying to the container.
- Node ≥ 22 and pnpm 11 in the sandbox. No `packageManager` field, so pnpm never downloads another version.

## Verify

```sh
pnpm tsx scripts/check-templates.ts            # all templates
pnpm tsx scripts/check-templates.ts workers-api --cold   # empty pnpm store: network install
```

For each template it copies the directory to a temp dir, renders placeholders, runs
`pnpm install --frozen-lockfile`, `lint`, `typecheck`, `test` and `build`, checks the build output, and for
Worker templates starts `wrangler dev` on the build and fetches every `template.json` route. It prints the time
of each phase.

Measured 2026-10-01 (Apple Silicon laptop, Node 22, pnpm 11.27; each `pnpm run` includes ~0.8 s of pnpm
startup, so the tools themselves are faster: esbuild 0.1 s, tsc 1.1 s, vitest 0.6 s):

| template | install warm / cold | lint | typecheck | test | build | CI path warm / cold | preview ready |
|---|---|---|---|---|---|---|---|
| workers-api | 2.5 s / 4.2 s | 2.3 s | 1.8 s | 3.1 s | 1.6 s | 5.6 s / 7.2 s | 3.2–4.5 s |
| preact-app | 3.3 s / 4.4 s | 3.0 s | 2.7 s | 3.6 s | 2.0 s | 6.9 s / 8.0 s | 4.3–5.0 s |
| ts-library | 2.4 s / 4.7 s | 2.7 s | 2.3 s | 3.3 s | 1.6 s | 5.7 s / 7.9 s | none |
| static-site | 2.4 s / 3.4 s | 3.0 s | 2.1 s | 2.8 s | 1.1 s | 5.4 s / 6.7 s | 3.3–3.8 s |

"Cold" uses an empty pnpm store, so every tarball is downloaded. "CI path" is install plus the slowest of the
four parallel steps, which is what `.platform/ci.ts` runs. It leaves out container start and snapshot restore
per step, which the sandbox adds.
