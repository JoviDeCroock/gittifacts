# Build: world-class documentation

**Source.** User request (2026-10-02): "We need world-class documentation for our platform, integrating with it,
committing to it, migrating from GitHub, using CI, ... anything possible. Avoid excessive prose and just make it
practical to follow for agents or humans." The rest of this document is the lead's spec.

## Principles
- **Task-first.** Every guide is "do X", told as numbered steps with copy-paste commands or tool calls and the expected
  output. Explanations stay to a sentence or two.
- **One source per fact.** Reference pages are **generated** from code, so they can't drift:
  - MCP tools
  - CLI commands
  - HTTP API (OpenAPI)
  - `.platform/policy.ts` schema
  - `.platform/ci.ts` DSL
  - error codes and fixes
  - evidence kinds
  - lane reason codes
  - limits and quotas
  - webhook events

  A CI check fails when generated pages are stale.
- **Agents and humans read the same pages.** Each page is served as HTML for browsers and as markdown with
  `Accept: text/markdown` or a `.md` suffix. `/docs/llms-full.txt` concatenates everything for agents; `/llms.txt`
  and `/start` link in.
- **Every sample is checked.**
  - Tool calls parse and name real tools.
  - JSON matches schemas.
  - Commands use real CLI flags.
  - Links resolve.
  - It's tested in CI.

## Information architecture
1. **Get started:** for agents (one URL → first green), for humans (sign in → plan → review a tour), and the CLI.
2. **Concepts:** Plan, Change, Evidence, Lanes, Tours, Merge queue, Rollouts and flags, Unclaimed projects, Principals and
   scopes. One short page each, with a diagram where it helps.
3. **Guides:**
   - Create a project, from a template or empty.
   - Make a Change: plan → change → push → wait → read the lane.
   - Committing and pushing with git: remotes, push grants, refreshing tokens.
   - Prove a fix (red/green).
   - Read and act on a tour (reviewers).
   - Configure CI (`.platform/ci.ts`: steps, caching, artifacts, test targets).
   - Write a policy (`.platform/policy.ts`: thresholds, sensitive paths, shadow mode, enabling Lane 0).
   - Reproducible transforms.
   - Previews and screenshots.
   - Deploy and roll out: deploy target, flags with `isChangeEnabled`, gradual stages, watch, revert.
   - Merge queue: enqueue, status, stacks, plan groups, ejections and fixes.
   - Remote workspaces (no shell).
   - Migrate from GitHub: import, detection plan, history, mirror, cut-over checklist.
   - Connect a deploy platform (Cloudflare, Netlify, …).
   - Build an integration: OAuth app, scopes, webhooks, deployments API, git URLs.
   - Authenticate: agent tokens, MCP OAuth, CLI device flow, sessions and revoke.
   - Claim a project.
   - Members and roles.
   - Troubleshooting (by symptom).
4. **Reference (generated):** MCP tools, CLI, HTTP API, policy schema, ci.ts DSL, error codes, evidence kinds, lane reason
   codes, limits and quotas, webhook events, discovery documents.
5. **Security model:** what agents can never do, separation of duties, signed evidence and verification, audit log, data
   residency.

## Delivery
- `packages/docs`: markdown content with front matter, generators, and a build that emits static HTML in the product's
  design system, `.md` twins, a search index, `/docs/llms-full.txt` and a sitemap. Served by the platform Worker at
  `/docs/*`, with content negotiation.
- Quality checks: link check, sample check, generated-pages-current check.
- Mobile-friendly reading, with copy buttons on code.
