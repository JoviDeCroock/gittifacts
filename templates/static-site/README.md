# {{projectName}}

A static site served by Cloudflare Workers static assets, from the gittifacts `static-site` template.
No Worker code: pages are plain HTML and CSS in `public/`.

- `/about/` is `public/about/index.html`; unknown paths get `public/404.html` with a 404 status.
- `pnpm test` checks that every page has a `lang`, a title, a viewport and a description, and that every
  internal link and asset exists.

```sh
pnpm install
pnpm test              # vitest
pnpm run build         # copies public/ → dist/
npx wrangler dev       # http://localhost:8787 (runs the build first)
```

Agents: read [AGENTS.md](AGENTS.md) before changing anything.
