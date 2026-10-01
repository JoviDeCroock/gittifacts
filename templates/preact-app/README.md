# {{projectName}}

A Preact + `@preact/signals` single-page app on Cloudflare Workers static assets, from the gittifacts
`preact-app` template. The Worker only handles `/api/*`; everything else is served from `dist/client`.

- `src/client/`: the app (`App.tsx`), state as signals (`state.ts`), entry (`main.tsx`)
- `src/worker.ts`, `src/api.ts`: the Worker and its JSON API (`GET /api/time`, `GET /api/health`)
- `public/`: `index.html` and static files, copied into `dist/client`

```sh
pnpm install
pnpm test              # vitest (state and API; no DOM needed)
pnpm run build         # esbuild → dist/client/app.js + dist/worker.js
npx wrangler dev       # http://localhost:8787 (runs the build first)
```

Agents: read [AGENTS.md](AGENTS.md) before changing anything.
