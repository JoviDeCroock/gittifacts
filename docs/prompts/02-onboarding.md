# Build: agent onboarding for the agent-native git platform

This is a follow-on to the main platform build (`docs/prompts/01-platform.md`). Read `STATUS.md`, `DECISIONS.md` and the
main build prompt first. Reuse the platform's primitives, packages and security rules rather than forking them.

Work autonomously. Stop only for the conditions in §9.

## 1. Goal

Make it extremely easy for an agent with **no prior context** to get started on the platform and create things.
Onboarding is a core feature, not documentation.

**North-star metric: time-to-first-green.** This is how long it takes an agent, starting from one URL, to have a repo, a
passing CI run and a live preview URL.
- Target: **under 60 seconds, with no human in the loop**.
- Measure it continuously (Analytics Engine) and show it on an internal dashboard.

Every design choice below serves that metric **without weakening the platform's safety model**: lanes, separation of
duties, and humans approving intent.

## 2. One front door

- `GET https://<host>/start` returns a short guide written for machines (markdown, or JSON with `Accept: application/json`).
  It covers what the platform is, how to authenticate (or skip auth, see §4), the MCP URL, and the 3 calls needed to ship something.
- Also serve:
  - `/llms.txt`
  - the current MCP server-discovery convention (check the latest MCP spec, don't guess)
  - `/openapi.json`
- **Acceptance:** an agent told only "use <host>" works out everything else from these endpoints.

## 3. Creating things in one call

### `create_project`
The MCP tool `create_project({ name?, template?, from?: githubUrl, description? })`, and the matching `POST /projects`,
do the whole setup in one call:

1. Create the Artifacts repo: from a template, imported via `Artifacts.import`, or empty.
2. Write the default `.platform/ci.ts`, `.platform/policy.ts` and `AGENTS.md`.
3. Run the first CI.
4. Deploy the first preview.

It returns:

```ts
{ projectId, remote, token, mcpUrl, previewUrl, claimUrl?, nextSteps: NextStep[] }
```

The call returns quickly. CI and preview finish asynchronously, and agents use `wait_for_change` (§5) to wait for them.

### Templates (at launch)
Each template passes CI and deploys a preview the moment it's created:

- Workers API (TS)
- Preact + signals app on Workers
- TS library (Vitest, with the `.d.ts` public-API diff working out of the box)
- Static site

### Imported repos
- Detect the package manager, test runner, build command and TS config, and generate `.platform/*` from them.
- For imports, the generated config arrives as a **Plan + Change that a human approves**. It's never applied silently,
  because policy changes are always Lane 2.
- If detection is unsure, say so in the Plan rather than guessing quietly.

### `AGENTS.md` in every repo
- It covers how to work on this platform:
  - start from a Plan
  - open a Change
  - fixes need red/green proof
  - what each lane means
  - how to read a tour
  - how to wait for results
- Keep it under 150 lines.
- It's generated from one source of truth in the platform. When conventions change, it's updated through a Change.

## 4. Auth with no friction, and no shortcuts on safety

### Claimable projects, no account needed
- An agent can call `create_project` without credentials.
- It gets an **unclaimed** project, a short-lived token for it, and a `claimUrl` to give to a human.
- Unclaimed projects expire after a configurable TTL (default 7 days) unless claimed.
- Claiming takes a human login + Turnstile.
- Model this on Cloudflare's workers.new unauthenticated playground.

### Hard limits on unclaimed projects
Unclaimed projects are the main abuse vector (crypto mining in CI, spam or phishing hosting on previews), so design for
that from day one:

- Tight CI-minute, storage and Artifacts-operation quotas.
- Sandbox network egress allowlisted to package registries only.
- No secrets, no custom domains, no production deploys (previews only), and the Lane 0 / auto-merge path off entirely.
- Preview URLs on a separate, clearly marked domain, with a banner on HTML responses.
- Per-IP, per-ASN and global rate limits, plus a kill switch that stops all unclaimed creation instantly.

### Delegated agents for logged-in users
- **MCP OAuth** (per the current MCP authorization spec) and an **OAuth device flow** for CLIs.
- Each agent session becomes its own `Principal { kind: "agent" }` with scopes the human picks.
- The default scope is "can open Changes on repo X".
- Agents can **never approve** a Plan or a Change, including their own.
- Show the human what they're granting in plain words, and let them revoke a session in one click.

## 5. Agent-grade ergonomics

These apply to **every** API endpoint, MCP tool and CLI command.

### Errors that say what to do next
Every error has this shape:

```ts
{ code, message, fix: { explanation, call?, command?, docsUrl? } }
```

Examples:
- A push to main → `fix.call = start_change({ planId })`.
- A fix without red/green proof → `fix.explanation` says which test needs to fail on base.

### Retries and waiting
- **Idempotency keys** on every create/mutate call. Agents retry.
- **Wait, don't poll.** `wait_for_change({ changeId, until: "evidence_ready" | "lane_assigned" | "tour_ready" | "merged" | "reverted", timeoutSec })`
  long-polls and is backed by the Change's Durable Object. Also offer webhook and SSE subscriptions.

### Self-description
- `whoami` / `capabilities` returns the principal, its scopes, the repo(s) it can act on, quotas, remaining AI/CI budget,
  and whether the project is claimed.

### Tool design
- Small, composable MCP tools with JSON output and tight descriptions.
- Once the toolset grows past ~15, add a `search_tools` discovery tool, in the spirit of `cf cli search`.

### CLI
- A thin CLI (`npx <name>`) with JSON output by default and `--human` for tables.
- Commands mirror the MCP tools one-to-one, and `init` calls `create_project`.

## 6. Agents that run entirely remotely

Many agents (cloud agents, chat agents) have no local shell or git. `open_workspace({ changeId })` gives them one:

- It starts a sandbox via `ctx.container`, restored from a dependency snapshot when one exists.
- The Change's fork is checked out via ArtifactFS (blobless, hydrated on demand).
- It exposes MCP tools `ws_exec`, `ws_read`, `ws_write`, `ws_diff` and `ws_commit_push`.
- The workspace sleeps when idle and shuts down after a TTL.
- Quotas and egress rules follow the project's claimed/unclaimed status.

**Acceptance:** a remote-only agent completes the full loop (Plan → Change → edit → push → evidence → tour) using MCP alone.

## 7. Prove it with an eval, not a demo

Create `evals/onboarding/`. Give fresh agents (no prior context, no repo access) **only** the `/start` URL and one task:

1. "Create a Workers API that returns the current time and get it deployed to a preview."
2. "Import <fixture GitHub repo> and fix the failing test." This must end with red/green proof in the evidence.
3. "Add a field to the TS library's public API." This must end in Lane 1 with a tour.
4. A remote-only variant of task 1, with no shell: `open_workspace` only.

### What to measure
- Success rate, number of tool calls, wall-clock time, errors hit, and time-to-first-green.
- Use at least 2 model providers through AI Gateway, and at least 5 runs per task per model.

### Gates
- Success rate ≥ 90% on every task.
- Median time-to-first-green ≤ 60s on task 1.
- **Zero** runs where an agent approves its own work or reaches production from an unclaimed project.

### How to improve
When an agent stumbles, fix the **platform**: an error message, a missing `fix` hint, a tool description, a template, or
`/start`. Never fix the eval prompt. Log each fix in `DECISIONS.md` with the eval run that triggered it.

## 8. Milestones (each ends green and deployed)

- **O1 – Front door + `create_project` from templates.**
  - Covers `/start`, `llms.txt`, MCP discovery, templates, `AGENTS.md` and `nextSteps`.
  - *Acceptance:* `create_project({ template: "workers-api" })` → green CI + preview URL in under 60s.
- **O2 – Ergonomics.**
  - Covers the error shape with `fix`, idempotency, `wait_for_change`, `whoami`/`capabilities` and the CLI.
- **O3 – Claimable projects + abuse limits.**
  - Covers unclaimed creation, TTL, the claim flow with Turnstile, quotas, the egress allowlist, rate limits and the kill switch.
  - *Acceptance:* tests show every limit in §4 is enforced.
- **O4 – Delegated auth.**
  - Covers MCP OAuth, the device flow, scoped agent principals and session revocation.
- **O5 – Import with detection + remote workspaces.**
  - Import produces its config as a Plan + Change. Adds `open_workspace` and the `ws_*` tools.
- **O6 – The onboarding eval passes its gates.**
  - Wire it into CI to run nightly. A regression blocks release.

## 9. When to stop and ask

- Anything that would let an agent approve work, bypass lanes, or reach production from an unclaimed project.
- Abuse limits you can't enforce with the available primitives.
- Costs beyond the dev tier, or beta access you can't get.

For everything else, decide, record the decision in `DECISIONS.md`, and keep going.
