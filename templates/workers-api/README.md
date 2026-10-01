# {{projectName}}

A JSON API on Cloudflare Workers, from the gittifacts `workers-api` template.

- `GET /` → `{ "now": "<ISO time>" }`
- `GET /health` → `{ "ok": true }`

Routes live in the `routes` table in `src/app.ts`; `src/index.ts` is the Worker entry. Tests are in `test/`.

```sh
pnpm install
pnpm test              # vitest
pnpm run build         # esbuild → dist/index.js (wrangler.jsonc `main`)
npx wrangler dev       # http://localhost:8787 (runs the build first)
```

Agents: read [AGENTS.md](AGENTS.md) before changing anything.
