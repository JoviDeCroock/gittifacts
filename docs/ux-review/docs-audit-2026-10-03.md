# Docs audit: onboarding paths, density and structure (2026-10-03)

The user's verdict: "they are incredibly dense; we want it to be digestible and easy to get
started", and "onboarding flows … quick success". This audit measures the docs at
`/docs` (packages/docs) as they stood on origin/main `a3a8972`, then sets the structure and the
writing rules for the rework. The result of the rework is at the end ([After](#after-the-rework)).

## Headline: the four onboarding paths, before

Each path is followed as written, from the docs home to its quick win. "Words" counts prose a
reader passes before the quick win (code excluded). Wall time is measured on the live platform
on 2026-10-03 (load on the measuring machine: 200-300).

| Path | Page | Steps before the quick win | Words before it | Prerequisites the page asks for | Quick win | Measured wall time |
|---|---|--:|--:|---|---|---|
| I'm an agent (MCP) | `get-started/agents` | 6 (front door, choose auth, whoami, create, wait, read) | 333 | a token, OAuth, or "nothing" (3rd row of a table) | green run + preview | 78 s, 6 MCP requests |
| Try it (CLI) | `get-started/cli` | 5 (version, alias, **log in**, init, wait) | 259 | **an account and a device-flow approval** | green run + preview | 60 s of commands (init 18.4 s cold, wait 41.9 s) **plus** sign-up and device approval |
| Move from GitHub | `guides/migrate-from-github` | 3 (import, check history, detection) | 628 | `$GITTIFACTS_TOKEN`, a clone URL with an undefined `<owner>` | first CI run + config proposal | 76.5 s (import 21.8 s, first CI 21 s, proposal 33 s) |
| Connect GitHub | `guides/github-mode` | 3 (register the App, install, open a PR) | 562 | a 15-row App registration form and 6 `wrangler secret put` (operator work) | graded PR | not measurable live: no test installation yet (STATUS: "live test org pending"); the page says "within about two minutes" |
| Sign up (human) | `get-started/humans` | 1 | 77 | none | signed in, "Repositories" | 5.5 s scripted: 3 clicks, 3 fields, no Turnstile |

What these numbers mean:

- **No account is needed for any of the first three quick wins**, and two pages still ask for one
  first. The CLI page puts `login` (sign-up plus a browser approval) before `init`, although
  `init` works anonymously and stores the project token itself. The agent page asks the reader to
  pick one of three auth methods and call `whoami` before `create_project`; `/start` does the
  same in three calls.
- **Platform time is already short** (about a minute to green). The cost is in reading and
  prerequisites: 260-630 words and a detour before the first useful command.
- **The import quick win isn't always green.** The fixture's first CI run on import was red
  (`test:failed`, a test that fails on GitHub too). The page must say what success looks like
  for a red repo: CI ran, and the proposal names steps that were already red.

## Method

1. **Inventory** of all 65 pages from the markdown: prose words outside code, code blocks, words
   before the first code block, lines (script: `scratchpad/docsaudit/inventory.mjs`).
2. **Layout probe** of the live pages at 1280 × 800 and 390 × 844 with Playwright: page height in
   screens, how far down the first command sits, paragraph measure, horizontal overflow.
3. **Three newcomer reads** on the live site at both widths: a developer who heard about
   gittifacts, a team lead moving a repo off GitHub, an agent with only `/start` and `/llms.txt`.
4. **Live runs** of each path, timed per step: the CLI anonymously from a cold npm cache, MCP
   over raw JSON-RPC with no credentials, an anonymous import of
   `JoviDeCroock/gittifacts-fixture-clock-api` up to the detection proposal, a headless sign-up.
   Logs: `scratchpad/docsaudit/measure/`.

## Where each newcomer gets lost

### A developer who heard about gittifacts

- **Home, first sentence:** four bold terms and three lane numbers before any action: "A human
  approves the **Plan** (the intent). The agent pushes a **Change**; the platform proves it with
  signed **evidence** and routes it to a risk **lane**: 0 auto-merge, 1 async glance, 2 full
  review." None is defined on the page and there is no glossary.
- **Home, second paragraph** is about the docs format ("Append `.md` to any URL, or send
  `Accept: text/markdown`"), which matters to agents, not to this reader.
- **"Start here"** is five rows by identity ("A human approving and reviewing", "Working from a
  terminal"). Nothing says "try it" or how long it takes; GitHub mode is missing.
- **The loop diagram is clipped at 1280 px** ("tour by a separate revie…", "rollout → wat…").
- **CLI page, step 1** spends 90 words on npx caching, `npm install -g`, `rm -rf ~/.npm/_npx`,
  `latest.json` and a "Coming soon" before the reader has done anything.
- **CLI page, step 2 is a dead end without an account:** "Open the URL signed in as yourself".
  Nothing says the next step works without it.

### A team lead moving a repo off GitHub

- **Step 1 branches at once:** "`from` takes public `https://` URLs only; for a private repo, push
  it (below)". Most team repos are private, yet that path is a 350-word detour inside step 1:
  `curl -b cookies.txt` (where does the cookie jar come from?), `http.postBuffer`, the grant's
  lifecycle and two audit event names.
- **Step 2 can't be run as written:** `git clone "https://<host>/git/<owner>/clock-api.git"` with
  `$GITTIFACTS_TOKEN`; neither `<owner>` nor the token is introduced on the page.
- **Step 3 carries a 120-word pnpm 11 caveat in the happy path** ("pnpm 11 fails the install
  (`ERR_PNPM_IGNORED_BUILDS`) while a dependency's install script is neither allowed nor denied
  …"). It matters to some repos, and only after the proposal exists.
- **Jargon before definition:** "bootstrap Change", "push grant", "an Artifacts repo in the EU
  jurisdiction", "Lane 2 because it touches `.platform/**`".
- **No end state.** The page never says what the reader has after step 3, and the cut-over
  checklist mixes setup (members, policy, agents) with leaving GitHub.
- **GitHub mode is invisible from here.** A team lead who wants to try gittifacts on real pull
  requests before moving learns nothing about it on the migration page or the home.
- **GitHub mode page, step 1 is operator work** ("Register the App (whoever runs the platform,
  once)"): a 15-row form and six `wrangler secret put` commands. On a hosted platform the reader's
  own first action, **Install on GitHub**, sits 3.1 screens down at 1280 px and 3.9 on a phone.

### An agent with only `/start` and `/llms.txt`

- **`/start` is the best page in the set:** three calls to a green run, rules, templates. It
  disagrees with the docs' own agent page, which adds "Authenticate" (three options) and
  `whoami` before `create_project` and says "Five tool calls later" over six steps.
- **`/docs/llms.txt` is a flat list of 65 pages** with no signal of where to begin; the
  getting-started pages are indistinguishable from the reference by their descriptions.
- **Live disagrees with the docs in two places** (both fixed on main, not deployed at audit time):
  `get_change_status` returns no `previewUrl` (the docs and `/start` promise it), and after
  `create_project({ from })` the `nextSteps` don't list `propose_platform_config` (the migration
  page says they do). `GET /api/v1/stats/first-green`, quoted on the get-started index, returns
  404 live.
- **Long-poll caveats repeat on every page:** "The call long-polls for up to 50 s, under the
  usual 60 s MCP request timeout"; "call again while `reason` is `"timeout"`, after
  `retryAfterSec` when it is set". Agents need it once, in the tool reference and `/start`.

## Layout probe (live, before)

| Page | Height at 1280 (screens) | Height at 390 | First command at 390 | Note |
|---|--:|--:|--:|---|
| `/docs` | 2.4 | 2.9 | 1.2 | loop diagram clipped at 1280 |
| `get-started/agents` | 5.1 | 5.7 | 0.5 | auth table squeezes to one word per line at 390 |
| `get-started/cli` | 4.1 | 4.8 | 0.6 | |
| `get-started/humans` | 3.6 | 4.6 | none | |
| `guides/migrate-from-github` | 5.4 | 6.5 | 0.5 | |
| `guides/github-mode` | 4.8 | 6.2 | 3.9 | user's first action 3.9 screens down |
| `guides/make-a-change` | 4.4 | 5.5 | 0.5 | |

The measure is fine (632 px, about 68 ch at 16 px). Height comes from structure: every H2 carries
a rule, 48 px above and 24 px of padding, so steps and sections look the same and a six-step page
runs five to six phone screens. Wide three-column tables (auth options, the App form) are the
worst offenders at 390 px.

## Top problems, ranked

| # | Problem | Page | Quote |
|--:|---|---|---|
| 1 | The quick win sits behind setup the reader doesn't need | `get-started/cli` | "## 2. Log in … Open the URL signed in as yourself" (before `init`, which works without it) |
| 2 | Same, for agents: auth choice and `whoami` before the first useful call | `get-started/agents` | "Pick one. All three end with `Authorization: Bearer <token>`" (the no-account row is third) |
| 3 | Operator setup before the user's first action | `guides/github-mode` | "## 1. Register the App (whoever runs the platform, once)" |
| 4 | One page, many jobs | `guides/migrate-from-github` | public import, private import by push, history check, detection, remotes, late commits, cut-over checklist |
| 5 | One page, many jobs | `get-started/humans` | sign in, connect an agent, approve a Plan, review a tour, shadow mode, Lane 0 |
| 6 | Caveats in the happy path | `get-started/cli`, `guides/migrate-from-github` | "`npx` caches a tarball by its URL: to pick up a newer CLI, clear that cache (`rm -rf ~/.npm/_npx`)"; "`http.postBuffer` matters: Artifacts refuses chunked uploads …" |
| 7 | Jargon before definition, no glossary | `index`, `guides/migrate-from-github` | "routes it to a risk **lane**"; "a bootstrap Change running CI with a default pipeline, and a push grant" |
| 8 | No "what you'll have", few "Next" links | all get-started pages, most guides | the agent page ends on "Rules you can't break"; the humans page on a bullet list |
| 9 | The same steps in five places | `get-started/agents`, `get-started/cli`, `guides/create-a-project`, `concepts/unclaimed-projects`, `/start` | create, wait, read the result; the change loop again in `get-started/cli` step 5 and `guides/make-a-change` |
| 10 | Front door by identity, not by goal | `index` | "A human approving and reviewing", "Building a deploy integration" |
| 11 | Steps look like sections; tall pages on phones | all step pages | every H2 has a rule and 72 px of space; agents page 5.7 phone screens |
| 12 | 20 guides in one flat sidebar list | sidebar | Create a project … Troubleshooting, no grouping |

## Target information architecture

```text
/docs  Pick your path ─┬─ I'm an agent ............ get-started/agents      (MCP, no account, 3 calls)
                       ├─ Try it in 2 minutes ..... get-started/cli         (one npx command, no account)
                       ├─ Move a repo from GitHub . get-started/from-github (import, first CI, config proposal)
                       └─ Connect GitHub .......... get-started/github      (install the App, graded PR)
       How it works in one picture · Glossary (8 terms) · Go deeper
       Reviewing an agent's work? get-started/humans (a short hub for reviewers)

Get started   the four paths + "For reviewers"; each: You'll have → 3-5 steps → expected result → Next
Concepts      unchanged pages, one idea each; edge cases folded into <details>
Guides        grouped in the sidebar: Daily work · Review · Set up a repo · GitHub · Help
              new: Use the CLI, Approve a Plan, Import a private repo, Register the GitHub App
              split: migrate-from-github keeps cut-over only; github-mode keeps grading after install
Reference     generated, unchanged
```

Page moves keep every URL: `get-started/cli` becomes the 2-minute path, `get-started/humans` the
reviewers' hub, `guides/migrate-from-github` the cut-over guide, `guides/github-mode` the grading
guide. New pages take new URLs, so nothing needs a redirect.

## Rules for the rework

1. **Quick win first.** Every getting-started path reaches a visible success (green check,
   preview URL, proposal, graded PR) in 3-5 numbered steps, before any configuration, policy,
   lanes or calibration. Those come after, as "Next".
2. **One step, one action, one result.** Each step has one copy-pasteable command or click and
   the expected output, shown as real output.
3. **Open with the outcome, close with Next.** The first line is "**You'll have:** …"; the last
   section is `## Next` with two or three links.
4. **Fold, don't inline.** Edge cases, limits, flags, alternatives and "why" go in `<details>` or
   in a linked concept or reference page. Agents still get every word in `llms-full.txt`.
5. **One job per page.** Getting-started pages stay under 400 words of visible prose, guides
   under 700 (code, tables and `<details>` excluded). The docs check enforces both.
6. **Define at first use.** A core term is linked to its glossary line or concept page the first
   time a page uses it.
7. **Plain language.** Short sentences, active voice, no stacked qualifiers, one term per concept
   (design-impeccable.md §2 Copy; the docs style check keeps paragraphs to four sentences).
8. **Facts stay with their owners.** Restructuring keeps every fact other agents wrote; it moves
   or folds them, it doesn't drop them.

## Inventory (before)

65 pages: 43 written by hand, 22 generated. Median prose words per page: 409 (hand-written: 340).
Get started: 4 pages, 1,469 words. Guides over 700 words: `github-mode` (1,027), `migrate-from-github` (871),
`troubleshooting` (820). "For" is the page's `audience`.

| Page | Title | For | Prose words | Code blocks | Words before first command | Lines |
|---|---|---|--:|--:|--:|--:|
| `concepts/changes.md` | Changes | both | 349 | 1 | 333 | 47 |
| `concepts/evidence.md` | Evidence | both | 502 | 3 | 451 | 74 |
| `concepts/index.md` | Concepts | both | 34 | 1 | 34 | 23 |
| `concepts/lanes.md` | Lanes | both | 340 | 1 | 187 | 46 |
| `concepts/merge-queue.md` | Merge queue | both | 285 | 2 | 109 | 45 |
| `concepts/plans.md` | Plans | both | 195 | 2 | 124 | 44 |
| `concepts/principals-and-scopes.md` | Principals and scopes | both | 314 | 1 | 314 | 58 |
| `concepts/rollouts-and-flags.md` | Rollouts and flags | both | 273 | 2 | 30 | 41 |
| `concepts/tours.md` | Tours | both | 206 | 3 | 51 | 48 |
| `concepts/unclaimed-projects.md` | Unclaimed projects | both | 308 | 1 | 63 | 39 |
| `get-started/agents.md` | Get started for agents | agent | 420 | 8 | 49 | 121 |
| `get-started/cli.md` | Get started with the CLI | both | 343 | 7 | 63 | 89 |
| `get-started/humans.md` | Get started for humans | human | 585 | 0 | none | 67 |
| `get-started/index.md` | Get started | both | 121 | 0 | none | 23 |
| `guides/authenticate.md` | Authenticate | both | 513 | 3 | 127 | 80 |
| `guides/claim-a-project.md` | Claim a project | human | 256 | 0 | none | 46 |
| `guides/configure-ci.md` | Configure CI (.platform/ci.ts) | both | 487 | 6 | 40 | 112 |
| `guides/connect-a-deploy-platform.md` | Connect a deploy platform | human | 371 | 1 | 320 | 56 |
| `guides/create-a-project.md` | Create a project | both | 318 | 4 | 136 | 77 |
| `guides/deploy-and-roll-out.md` | Deploy and roll out | both | 489 | 6 | 103 | 101 |
| `guides/git.md` | Commit and push with git | both | 501 | 8 | 128 | 110 |
| `guides/github-mode.md` | Grade pull requests on GitHub | human | 1027 | 3 | 347 | 119 |
| `guides/index.md` | Guides | both | 26 | 0 | none | 13 |
| `guides/integrations/cloudflare-workers.md` | Example: connect a Cloudflare Workers project | both | 176 | 0 | none | 30 |
| `guides/integrations/deployments.md` | Deployments API | both | 124 | 1 | 20 | 29 |
| `guides/integrations/git.md` | Git access | both | 135 | 2 | 2 | 30 |
| `guides/integrations/index.md` | Integrations | both | 409 | 0 | none | 61 |
| `guides/integrations/oauth.md` | Install flow (OAuth) | both | 234 | 4 | 44 | 61 |
| `guides/integrations/webhooks.md` | Webhooks | both | 211 | 2 | 173 | 69 |
| `guides/make-a-change.md` | Make a Change | agent | 440 | 8 | 34 | 89 |
| `guides/members-and-roles.md` | Members and roles | human | 297 | 3 | 108 | 63 |
| `guides/merge-queue.md` | Use the merge queue | agent | 418 | 6 | 66 | 89 |
| `guides/migrate-from-github.md` | Migrate from GitHub | both | 871 | 8 | 37 | 116 |
| `guides/previews.md` | Previews and screenshots | both | 391 | 1 | 223 | 63 |
| `guides/prove-a-fix.md` | Prove a fix (red/green) | agent | 409 | 6 | 67 | 82 |
| `guides/remote-workspaces.md` | Remote workspaces (no shell) | agent | 307 | 10 | 55 | 93 |
| `guides/review-a-tour.md` | Read and act on a tour | human | 393 | 1 | 363 | 64 |
| `guides/transforms.md` | Reproducible transforms | both | 286 | 5 | 54 | 75 |
| `guides/troubleshooting.md` | Troubleshooting | both | 820 | 0 | none | 73 |
| `guides/write-a-policy.md` | Write a policy (.platform/policy.ts) | human | 451 | 3 | 78 | 78 |
| `index.md` | gittifacts docs | both | 222 | 1 | 135 | 49 |
| `reference/index.md` | Reference | both | 104 | 0 | none | 29 |
| `security.md` | Security model | both | 666 | 1 | 373 | 76 |

Generated reference pages (not hand-edited; listed for size):

| Page | Prose words | Lines |
|---|--:|--:|
| `reference/ci-dsl.md` | 379 | 105 |
| `reference/cli.md` | 1325 | 196 |
| `reference/discovery.md` | 222 | 86 |
| `reference/errors.md` | 1185 | 79 |
| `reference/events.md` | 448 | 71 |
| `reference/evidence-kinds.md` | 926 | 197 |
| `reference/http-api.md` | 1466 | 129 |
| `reference/http-changes.md` | 733 | 208 |
| `reference/http-github.md` | 254 | 79 |
| `reference/http-identity.md` | 585 | 189 |
| `reference/http-integrations.md` | 907 | 279 |
| `reference/http-merge-queue.md` | 440 | 118 |
| `reference/http-platform.md` | 348 | 93 |
| `reference/http-repos.md` | 1018 | 247 |
| `reference/lane-reasons.md` | 1571 | 130 |
| `reference/limits.md` | 1002 | 116 |
| `reference/mcp-changes.md` | 771 | 179 |
| `reference/mcp-merge-queue.md` | 511 | 119 |
| `reference/mcp-projects.md` | 583 | 111 |
| `reference/mcp-tools.md` | 840 | 92 |
| `reference/mcp-workspaces.md` | 672 | 135 |
| `reference/policy.md` | 548 | 110 |
