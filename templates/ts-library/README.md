# {{projectName}}

A TypeScript library, from the gittifacts `ts-library` template: `slugify()` and `truncate()` to start with.

Everything exported from `src/index.ts` is the public API. `pnpm run build` emits `dist/*.js` and `dist/*.d.ts`,
and `package.json` `exports`/`types` point at them, so the platform diffs the public API of every Change:
no change, additive (Lane 1) or breaking (Lane 2).

```sh
pnpm install
pnpm test              # vitest
pnpm run build         # tsc → dist/ (JS + declarations)
```

Rename the package in `package.json` before publishing. Agents: read [AGENTS.md](AGENTS.md) first.
