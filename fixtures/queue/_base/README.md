# queue-fixture

Base tree for the merge-queue fixture scenarios (see `fixtures/queue/README.md` in gittifacts).

- `@queue/money`: integer-cent rounding and formatting (barrel `src/index.ts`).
- `@queue/text`: `slug` and `title` subpath exports (no barrel).
- `@queue/api`: the `queue-api` Worker; its `price` route formats prices with `@queue/money`.
