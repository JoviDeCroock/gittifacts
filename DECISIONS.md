# Decisions

ADR-style log. Newest at the bottom. Format: `## YYYY-MM-DD — title`, then Context / Decision / Consequences.

## 2026-10-01 — Monorepo, pnpm workspaces, TypeScript 6.0, vitest 4

**Context.** TypeScript 7 (native) is out, but our evidence tooling (`.d.ts` API diff, Stryker's
TS checker) needs the JS compiler API, and `@cloudflare/vitest-pool-workers@0.22` peers on vitest ^4.1.

**Decision.** pnpm 11 workspaces, TypeScript 6.0.3 everywhere, vitest 4.1.x. Packages are
source-first (`exports` → `src/index.ts`); bundling happens in the Worker/Vite build.

**Consequences.** One TS toolchain for both platform code and the sandbox's API-diff step.
Revisit TS 7 once the evidence tooling has a stable non-JS API path.

## 2026-10-01 — Evidence items carry an explicit status; added `llm-judgment` item

**Context.** "Unknown → escalate" needs the classifier to separate *measured and fine*,
*not applicable*, and *measurement failed*. The prompt's evidence union has no slot for model judgments.

**Decision.** Every `EvidenceItem` has `status: ok | skipped | error`. Added an `llm-judgment` kind
(scope drift / plan conformance / hidden behavior change) so model signals are signed and audited
with the rest of the evidence. The classifier may only use them to raise a lane.

## 2026-10-01 — Plans declare `scopePaths` and `affectedRoutes`

**Context.** Scope drift ("diff touches files outside the plan") must be decidable without a model.

**Decision.** `Plan.scopePaths` (globs) and `Plan.affectedRoutes` were added to the domain model.
An empty `scopePaths` is "not declared", which counts as unknown, so it blocks Lane 0 but does not by
itself force Lane 2.

## 2026-10-01 — Policy is read from the base branch

**Decision.** The policy that governs a Change is the one in `.platform/policy.ts` on the default
branch at `baseSha`, never the head. A Change that modifies the policy file is always Lane 2 and
needs a human approval from someone other than the author.
