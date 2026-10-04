# Product

<!-- impeccable:product-schema 1 -->

> Written by the web agent from the explicit build brief, `CLAUDE.md`, `docs/api.md` and the domain
> schemas. No interview channel to the user existed in that session, so every line marked
> _(inferred)_ is an assumption to confirm, not a confirmed answer.

## Platform

web

## Stack

Preact 11 + @preact/signals + preact-iso, built with Vite (`@preact/preset-vite`). Hand-written CSS with
custom properties, no CSS framework. Served as static assets with SPA fallback by the platform Worker
(`apps/platform`). Pinned by the brief, not chosen here.

## Users

- **Primary: senior engineers and tech leads who supervise fleets of coding agents.** They own the
  outcome of changes they did not type. Their attention is the scarce resource the product protects.
- **Two scenes, one person.** Triage on a phone between meetings (one hand, 1 to 3 minutes, daylight
  or office light, frequently interrupted). Deep review at a desk on a large screen (full reviews,
  plan writing, rollout incidents). _(inferred split from the brief: "triage on their phone between
  meetings and do deep review on desktop")_
- **Secondary: agents** (actors; `principal` in the API). They never see this UI; they act through the API and MCP. Humans
  create them, scope them, and are accountable for them.
- **Repo admins** decide when auto-merge stops calibrating (turn it on) and edit policy. _(inferred: same people,
  admin hat)_

## Product Purpose

gittifacts is an agent-native git platform on Cloudflare. Coding agents write most of the code; the
platform makes human attention go to intent instead of line-by-line review.

> Humans approve intent. Machines prove conformance. The platform routes each change to the cheapest
> review that is still safe, and makes changes easy to undo after merge.

- A **Plan** states intent, acceptance criteria, out-of-scope items, risk declarations, scope paths and
  affected routes. A human (never its author) approves it up front; approval is a signed act.
- A **Change** is like a pull request, plus its proof: intent + diff + signed evidence. The classifier
  routes it to a **lane**, named first with the number as a badge: **Auto-merge** (Lane 0; the repo
  starts **calibrating**: computed, off until humans agree often enough), **Quick review** (Lane 1:
  read the walkthrough and approve, often on a phone, under 3 minutes), **Full review** (Lane 2).
- A separate reviewer agent writes a **walkthrough**: ordered stops (intent, behavior before/after, riskiest
  hunk, its proof, what is not covered), each with a verdict (proven / unproven / risk) anchored to
  evidence, plus mandatory "least confident" and "not done" lists.
- After merge: gradual **rollout** (5% → 25% → 100%) behind a per-change flag, a **watch window**, and
  automatic **revert**.

Success: a reviewer can decide a quick review on a 390px phone in under three minutes and trust that
decision; a full reviewer can find the riskiest hunk and its proof without hunting; nobody approves
something the evidence does not support.

## Positioning

The review unit is the walkthrough, not the diff. Evidence is signed (Ed25519) and verifiable outside the
platform; the audit log is hash-chained. Lanes are computed from evidence, and "unknown" always
escalates. A neighbouring code host cannot truthfully claim: risk-routed review with calibrated
auto-merge, reviewer-agent walkthroughs with explicit uncertainty, and per-change rollout with
automatic revert in one flow.

## Operating Context

- Reviewing on a phone in a corridor or a cab; resuming after interruptions. State must survive
  leaving and coming back. _(inferred)_
- Deep review at a desk, keyboard first, often next to an editor and a terminal. _(inferred)_
- Rollout incidents are time-pressured: the switch-off control and the error rate must be visible without
  hunting.
- Vocabulary is fixed app-wide (DECISIONS 2026-10-04, `@app/domain/vocabulary`): Plan, Change, lane
  (Auto-merge · Quick review · Full review, "(Lane N)" as the badge), reason, calibrating,
  report-only (GitHub), walkthrough, stop, verdict, evidence, attestation, rollout, watch window,
  switch off, revert, repo, actor, scope.

## Capabilities and Constraints

- HTTP contract: `docs/api.md`. Types: `@app/domain` (`model.ts`, `policy.ts`) and `@app/evidence`.
- Auth: better-auth (GitHub OAuth + email/password) for humans; agent bearer tokens for agents.
- Rules the UI must enforce or reflect: nobody approves their own Plan or Change; a missing or
  errored measurement may only raise risk; LLM judgments only raise a lane; policy is read from the base
  branch; only the merge queue writes the default branch.
- Agent tokens are shown exactly once.
- The backend may not exist yet: the UI ships with a mock backend (`VITE_MOCK=1` or `?mock`).

## Brand Commitments

- Name: **gittifacts** (lowercase). No logo exists yet. _(observed)_
- Voice: calm, precise, trustworthy, quietly confident. A tool you trust with production. No hype,
  no gamification, no humor on errors.

## Evidence on Hand

- No real customers, metrics, or screenshots exist. All sample data in `src/api/fixtures.ts` is
  synthetic and must stay labeled as demo data in mock mode. Never invent benchmarks or adoption
  claims.

## Product Principles

1. **Uncertainty is first-class.** "Least confident" and "not done" get the same prominence as what
   was proven. Unknown never reads as good.
2. **Approval is a deliberate, signed act.** Pessimistic UI, named consequences, no self-approval.
3. **The cheapest safe review.** Every screen answers "what do I need to look at, and why this lane?"
   before anything else.
4. **Reversible by default.** Rollout state, the switch-off control, and the revert link are always one step
   away from a merged change.
5. **Phone first for triage, desk for depth.** Same information architecture at every width.

## Accessibility & Inclusion

WCAG 2.2 AA. Color is never the only signal (verdicts, lanes, red/green tests each carry shape and a
label). 44px touch targets, visible focus, reduced-motion alternatives, 16px inputs. _(brief)_
