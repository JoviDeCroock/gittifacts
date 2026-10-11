# gittifacts

An agent-native git platform on Cloudflare.

**Humans approve intent. Machines prove conformance.** The platform routes each change to the
cheapest review that is still safe, and makes changes easy to undo after merge.

- The unit of work is a **Change**: like a pull request, plus its proof (intent + diff + evidence).
- Humans approve the **Plan**. A diff gets a conformance check against that plan.
- Every Change gets a **review lane**, computed from objective, signed evidence: **Auto-merge**
  (Lane 0), **Quick review** (Lane 1) or **Full review** (Lane 2). Auto-merge starts off while a repo
  **calibrates**: people review everything until they agree with the platform often enough.
- Quick and full reviews come with a **walkthrough**, written by a reviewer agent that is not the author.
- On GitHub, gittifacts runs **report-only**: it grades each pull request but never blocks or merges it.
- Merged changes roll out gradually behind a per-change flag and revert themselves on regressions.

See `STATUS.md` for what works today and `DECISIONS.md` for why things are the way they are.

## Run it locally

No Cloudflare account needed: the real platform Worker runs under `wrangler dev --local`, with
in-memory fakes for the three things that have no local equivalent (Artifacts, containers and
the model).

```sh
pnpm install --frozen-lockfile
pnpm --filter @app/e2e prepare-assets   # web app, docs and CLI the Worker serves
pnpm --filter @app/e2e serve            # http://127.0.0.1:8799
```

Agents start at `/start` (or MCP at `/mcp`); docs are at `/docs`.

Tests (targeted; `docs/testing.md` has the tiers):

```sh
cd apps/platform && pnpm exec vitest run test/integration/many-agents.test.ts --maxWorkers=1
pnpm --filter @sim/merge-queue gates    # the merge queue on a simulated 600-Change workload
```

## Deploy your own

`docs/deploy.md` is the runbook for the reference deployment: a Workers Paid account with
Artifacts (an EU namespace), D1, R2, Queues, Workflows, Containers (Docker builds the image), AI
Gateway and Flagship, plus the secrets it lists. Account ids, routes and hosts in
`apps/platform/wrangler.jsonc` are that deployment's; change them to yours.

## See many agents at once

`scripts/e2e/many-agents.ts` registers N agents that start, push and enqueue Changes on one repo
concurrently against a deployed platform, then prints a timeline. `docs/demo.md` is a 10-minute
demo built around it.

## License

MIT, see `LICENSE`.
