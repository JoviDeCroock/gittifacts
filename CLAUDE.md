# gittifacts — working agreements for agents

Agent-native git platform on Cloudflare. Product rule (drives every judgment call):

> Humans approve intent. Machines prove conformance. The platform routes each change to the
> cheapest review that is still safe, and makes changes easy to undo after merge.

## Layout
- `packages/evidence` — STANDALONE. Evidence schemas, canonical JSON, Ed25519 attestation, git-notes
  format, verify CLI. Must never import from other `@app/*` packages.
- `packages/domain` — shared zod schemas/types (Plan, Change, Tour, Principal, AuditEvent, RepoPolicy).
- `packages/classifier` — PURE `classify()` → lane + reasons. No I/O, no clocks, no randomness.
- `packages/ci-engine` — `CiEngine` interface, pipeline DSL, `CloudflareCiEngine` + `WorkflowsCiEngine`.
- `packages/coordinator` — Durable Objects (change coordinator, merge queue) + Workflows.
- `packages/tour` — reviewer agent (separate from the author), tour schema validation.
- `packages/mcp` — MCP tools for agents.
- `packages/web` — Preact + @preact/signals UI (mobile-first). Design rules: docs/research/design-impeccable.md.
- `apps/platform` — the Worker: Hono API (+OpenAPI), better-auth, Drizzle/D1, bindings, static assets.
- `apps/sandbox` — container image used for CI steps / evidence tools.
- `fixtures/` — fixture repos used by integration tests.
- `docs/research/` — verified notes on Cloudflare primitives. Docs win over the original prompt;
  record differences in DECISIONS.md.

## Rules
- TypeScript strict, no `any` at module boundaries. Validate every external input with zod.
- Unknown → escalate: a missing or errored signal may only raise risk, never lower it.
- LLM judgments may only raise a lane.
- No principal approves its own Plan or Change. Only the merge queue writes the default branch.
- Policy is always read from the BASE (default branch), never from the change's head.
- Imports inside packages use `.js` suffixes on relative paths (bundler resolution maps to .ts).
- Tests: vitest 4 (`@cloudflare/vitest-pool-workers` for Worker code). Run `pnpm -r test`.
- Commit small and often with clear messages. Don't edit files owned by another in-flight agent.
- Keep DECISIONS.md (dated ADR entries) and STATUS.md current.
