# clock-api

A tiny Cloudflare Worker: `GET /?offset=<minutes>` returns the current time at that UTC offset.

```sh
pnpm install
pnpm test        # vitest
pnpm run build   # esbuild → dist/index.js
npx wrangler dev
```

Known bug: offsets west of UTC that aren't whole hours (Newfoundland, -03:30) are formatted
wrong. `pnpm test` shows the failing case.
