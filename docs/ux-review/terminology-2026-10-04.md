# Terminology review, 2026-10-04

A proposal only. Nothing is renamed until the user decides (questions at the end). Read against
origin/main `e14dfbd`. Sources: landing (`packages/web/src/landing`), app (`packages/web/src`),
docs (`packages/docs/content`), CLI (`packages/cli`), MCP (`packages/mcp`), `/start` and
`llms.txt` (`packages/conventions`), GitHub check run, review and summary (`packages/host-github`).
Writing rules: design-impeccable.md §Copy ("one term per concept app-wide, keep a glossary") and
the docs audit's rule 6 ("define at first use") and rule 7 ("one term per concept").

The test for every term: would a developer, a team lead coming from GitHub, or an agent reading
`/start` know what it means on first sight, and does every surface say it the same way?

## The 5 renames that matter most for onboarding

| # | Old | New (label) | Why | Cost |
|---|---|---|---|---|
| 1 | Lane 0 / 1 / 2, with 7 different glosses ("auto-merge", "no review needed", "eligible to merge without a human", "async glance", "Glance", "a quick look with a guided tour", "full review") | **Auto-merge · Quick review · Full review**, the numeral kept as a badge: "Quick review (Lane 1)" | A newcomer can't decode a numeral, and today each surface explains it differently. The names say what a person must do. | Copy only. `lane: 0\|1\|2`, `computedLane`, `laneReasons`, `lane_assigned` and the `gittifacts/lane` check name stay. The check-run parser (`readCheckRunVerdict`) keys on the `\| Lane \| **N** \|` row; keep that row. |
| 2 | "Shadow mode", used for two different things | **Calibrating** (native: auto-merge is off until people agree with the platform) and **Report-only** (GitHub: gittifacts grades, never blocks or merges) | One word, two meanings, and neither is guessable ("shadow" reads as hidden). The app already says "Calibrated: Lane 0 can be turned on" (BacktestCard). | Copy, plus the check-run parser must accept both title prefixes (`Shadow ·` on old runs, the new one on new runs). The `shadow` field and the `shadow.*` reason codes stay. |
| 3 | "project" and "repo" for the same id (`create_project` returns `projectId`, described as "The repo id: use it as repoId in every other tool") | **repo** everywhere in copy | Two words for one thing; the first MCP call teaches the wrong one. GitHub people say repo; URLs (`/repos/:repoId`, `/api/v1/repos`) and every other tool that names a repo (`repoId`) already do. | Copy, plus add `repoId` to the `create_project` output and keep `projectId` as a deprecated alias. Keep the tool name `create_project` (agents and old CLIs call it). |
| 4 | "Tour", and the GitHub button "Approve tour" | **Walkthrough** (a stop stays a stop); the button becomes **Approve change** | In a web app "tour" means the product's onboarding tour. And you approve the change, not the tour: the app's own button already says "Approve this change". | Copy. `tour`, `get_tour`, `tour_ready`, `/changes/{id}/tour` and the check-run action id `approve_tour` stay (an action id is never shown). |
| 5 | "push grant" (32 uses) next to "push token" (17, and the tool `refresh_push_token`); "bootstrap Change" (43) | **push token**; **first Change** | Both were in the docs audit's "jargon before definition" list. Each replacement is a word the product already uses elsewhere. | Copy only. `bootstrapChangeId` stays in the API. |

Keep, but define better: **Change**, **Plan**, **evidence**, **merge queue**, **policy**. Their
problems are definitions and case, not the words (see the glossary).

## Inventory

Raw matches on origin/main, tests excluded. Docs counts are prose plus examples; code counts
include some identifiers, so read them as "how widespread", not as exact copy counts.
Columns: Land = landing, App = web app, Docs, CLI, MCP, Start = `/start` + `llms.txt`,
GH = GitHub check run, review and summary. **Exposed** = appears in an API field, URL, tool name
or other machine contract (costly to rename).

| Term | Land | App | Docs | CLI | MCP | Start | GH | Exposed | Problem |
|---|---|---|---|---|---|---|---|---|---|
| Lane 0/1/2 | 11 | 68 | 161 | 1 | 15 | 41 | 23 | `lane`, `computedLane`, `laneReasons`, `lane0Enabled`, `setLane0`, `lane_assigned`, check `gittifacts/lane` | numerals need decoding; 7 glosses across surfaces |
| auto-merge | 0 | 5 | 20 | 1 | 2 | 7 | 1 | `revertAutoMerge`, `revert.auto-merge` | fine; becomes the Lane 0 name |
| glance / quick look | 2 | 2 | 3 | 1 | 0 | 4 | 4 | none | "glance" doesn't say an approval is needed |
| full review | 4 | 3 | 6 | 1 | 0 | 2 | 6 | check action `full_review` | fine |
| `action_required` | 0 | 0 | 1 | 0 | 0 | 0 | 4 | GitHub conclusion enum | GitHub's word; shared by Lane 2 and blocked, the title tells them apart |
| Plan | 3 | 26 | 104 | 0 | 10 | 33 | 27 | `/api/v1/plans`, `/plans/:planId`, `create_plan`, `planId`, PR marker `gittifacts-plan:` | ordinary English word; also Claude Code's "plan mode"; "plan" vs "Plan" case varies |
| Change | 3 | 68 | 386 | 1 | 60 | 66 | 14 | `/api/v1/changes`, `/changes/:changeId`, `start_change`, `close_change`, `changeId`, flag `change-<id>` | ordinary English word; docs home says "the platform's version of a pull request", concepts says "It is not a pull request" |
| evidence | 24 | 104 | 141 | 4 | 25 | 24 | 29 | `get_evidence`, `evidence_ready`, `/changes/{id}/evidence` | clear |
| tour | 12 | 122 | 89 | 0 | 28 | 13 | 55 | `get_tour`, `tour_ready`, `/changes/{id}/tour`, action `approve_tour` | collides with "product tour"; "Approve tour" approves the wrong object |
| stop (tour stop) | 2 | 76 | 39 | 2 | 9 | 4 | 31 | `stops[]` | fine inside a walkthrough; "step" is taken by CI |
| signal / reason / gate | 5 / 1 / 0 | 88 / 0 / 1 | 43 / 7 / 11 | * | 0 | 4 | 0 / 1 / 2 | reason codes (106), `checklist` | three words for "why this lane"; UI says "Why Lane 2 · 7 signals" over a list of reasons |
| shadow mode | 3 | 81 | 40 | 4 | 5 | 8 | 46 | `shadow`, `shadow.lane0-disabled`, check title prefix `Shadow ·` (parsed) | two meanings (native calibration vs GitHub non-blocking) |
| calibration / agreement | 0 | 11 | 10 | 0 | 0 | 4 | 3 | none | already in the app; the right word for native shadow mode |
| claim / unclaimed | 4* | 94 | 192 | 11 | 21 | 82 | 13 | `claim.status`, `claimUrl`, `/claim/:token`, `/api/v1/claims`, and `change.claim.category` | two meanings: take ownership of a repo, and the author's category |
| red/green | 1 | 14 | 43 | 0 | 1 | 19 | 0 | kind `red-green`, `red-green.*` codes | spelled red/green (26), red-green (51), Red → green (3) |
| mutation | 2 | 24 | 33 | 0 | 21 | 2 | 2 | kind `mutation` | known testing term; needs a one-line gloss |
| judge / model judgment | 1 | 4 | 3 | 0 | 0 | 0 | 1 | kind names | "judge" sounds final; it can only raise a lane |
| principal | 1 | 48 | 49 | 0 | 10 | 2 | 3 | `/api/v1/principals`, `principalId` | IAM jargon; GitHub says "actor" |
| fork | 7 | 12 | 78 | 0 | 22 | 19 | 11 | `forkName`, `task-<id>` | GitHub forks are for outsiders; here every Change has one. Keep, define |
| push grant / push token | 0 / 2 | 0 / 1 | 27 / 8 | 0 | 4 / 1 | 1 / 4 | 0 | `refresh_push_token` | two names for one thing |
| merge queue | 6 | 42 | 109 | 2 | 8 | 9 | 3 | `enqueue`, `queue_status`, `/queue` | matches GitHub's merge queue |
| track / batch | 0 | 54 / 106 | 21 / 38 | 0 | 12 / 8 | 0 | 0 | queue API fields | fine; "track" is new but self-explaining |
| train (deploy) | 0 | 26 | 4 | 0 | 0 | 0 | 0 | `trains` in queue API | GitLab users read "merge train" = merge queue |
| rollout | 10 | 86 | 57 | 0 | 0 | 7 | 0 | `/changes/{id}/rollout`, `rolling-out` | clear (Vercel, LaunchDarkly) |
| kill / kill switch | 0 | 11 | 25 | 0 | 0 | 7 | 0 | `/changes/{id}/kill`, `kill` action | two meanings: an operator's kill switch, and switching one Change's flag off |
| flag | 6 | 26 | 55 | * | 0 | 3 | 0 | flag `change-<id>` | clear |
| revert / roll back | 4 | 99 | 61 | 2 | 12 | 15 | 58 | status `reverted` | two acts (traffic back to the old version, a revert commit); docs blur them |
| workspace | 0 | 6 | 71 | 0 | 33 | 23 | 0 | `open_workspace`, `ws_*` | clear ("remote workspace", like Codespaces) |
| bootstrap Change | 0 | 5 | 16 | 11 | 7 | 3 | 0 | `bootstrapChangeId` | jargon on the very first call |
| detection Plan / import Plan | 0 | 0 | 2 | 0 | 0 | 0 | 0 | none | barely used; "proposed setup" already wins |
| platform config / `.platform/` | 0 | 0 | 73 | 2 | 11 | 29 | 2 | `propose_platform_config`, path `.platform/` | copy says "proposed setup"; tool says config. Fine |
| policy | 4 | 66 | 114 | 1 | 4 | 17 | 6 | `.platform/policy.ts` | clear; needs "read from main" every time |
| scope paths | 1 | 4 | 13 | 0 | 5 | 5 | 6 | `scopePaths` | fine as a Plan field label ("Paths it may touch") |
| verdict | 1 | 33 | 14 | 0 | 5 | 1 | 30 | `verdict` on stops; `LaneVerdict` (internal) | three meanings: a stop's proven/unproven/risk, a reviewer's lane pick, a GitHub grade |
| grade / graded | 0 | 11 | 19 | 1 | 3 | 0 | 65 | `graded` outcome | GitHub mode's word for "a lane was assigned"; fine there |
| project / repo | 3 / 10 | 50 / 287 | 231 / 444 | 79 / 10 | 22 / 52 | 67 / 32 | 0 / 120 | `create_project`, `projectId`, `/api/v1/projects`; `repoId`, `/repos/:repoId` | one id, two names |

\* CLI "signal" is mostly `AbortSignal` and CLI "flag" is mostly command-line flags; landing "claim"
includes marketing claims.

## Proposed glossary

Ranked by onboarding value. "Copy" = UI, docs, CLI text, tool descriptions and GitHub text only.
"Keep API" = every field, URL, tool name and code stays; agents and old CLIs depend on them.

| # | Old → new | Definition a newcomer understands | Why, and alternatives considered | Cost |
|---|---|---|---|---|
| 1 | **Lane** (keep) with names: Lane 0 → **Auto-merge**, Lane 1 → **Quick review**, Lane 2 → **Full review** | How much human review a Change gets. Auto-merge: nobody reviews; the evidence decides. Quick review: a person reads a short walkthrough and approves. Full review: a person reads the diff, with the walkthrough as a guide. | The names say what a person does; the numeral stays as the badge and in the API. "Lane" is fine as the noun ("review lane" at first use). Alternatives: "review level" (loses the routing idea), "Glance" for Lane 1 (kept by the app today, but it hides that an approval is needed), "Light review". | Copy. Keep API. Keep the `\| Lane \| **N** \|` row the check-run parser reads. |
| 2 | **Shadow mode** (native) → **Calibrating** | Auto-merge is off. People review everything and say which lane they would have picked; once they agree with the platform often enough (95% over 25 reviews), an owner can turn auto-merge on. | It names the purpose. The app already says "Calibrated" and "agreement". Alternatives: "Training" (the app says "Your call trains shadow mode"; but sounds like model training), "Auto-merge off". | Copy. Keep `shadow`, `shadow.*` codes. |
| 3 | **Shadow mode** (GitHub) → **Report-only** | gittifacts grades each pull request and reports a lane, a walkthrough and evidence. It never blocks, approves or merges; GitHub still does. | A GitHub lead knows "report-only" (CSP) and "non-required check". Alternative: "Evaluate" (GitHub rulesets' own word for "test without enforcing", but only Enterprise users know it), "Advisory". | Copy, check title prefix (parser accepts old and new). Keep `shadow`. |
| 4 | **project** → **repo** | A git repo on gittifacts, with its CI, previews and settings. | One id, two names; the URLs and other tools say repo. Alternative: keep "project" for the whole bundle (Vercel's word), but then `repoId` everywhere is the odd one. | Copy. Add `repoId` to `create_project` output, keep `projectId` as an alias; keep tool name and `/api/v1/projects`. |
| 5 | **Tour** → **Walkthrough**; "Approve tour" → **Approve change** | A short guide to a Change written by a second agent that didn't write the code: riskiest part first, each stop tied to evidence, plus what it is least sure of and what it didn't do. | "Tour" in a web app is the onboarding tour. Alternatives: "guided review" (clear, but "review" is already the human's act), "review guide". | Copy. Keep `tour`, `get_tour`, `tour_ready`, `approve_tour`. |
| 6 | **push grant** → **push token** | A token that lets you push to one Change's fork for up to an hour. | The tool is `refresh_push_token` and the landing says push token. Alternative: "push credential". | Copy only. |
| 7 | **bootstrap Change** → **first Change** | The Change `create_project` opens for you: the template, its first CI run and preview. | Says what it is in plain words; DECISIONS already titles it "the first Change". | Copy. Keep `bootstrapChangeId`. |
| 8 | **Change** (keep) | Like a pull request, plus its proof: one unit of work with its intent, its diff and the evidence, pushed to its own fork. | Gerrit's word for the same thing; in GitHub mode one Change is one pull request. Fix the contradiction: the home says "the platform's version of a pull request", the concept page says "It is not a pull request". Pick the first. Capitalize it in docs and app; the landing writes "change". Alternative: "pull request" (wrong: no branch in your repo, reviews bind to a head). | Copy (definition, case). Keep API. |
| 9 | **Plan** (keep) | What a Change is for and how to tell it worked, approved by a person before the work counts. | Short and right; a "spec" or "ticket" is close, but Plan is in every tool and URL. Always say "approved Plan" when it matters. Alternatives: "Spec" (familiar to agents from spec-driven tools), "Intent". | Copy (case). Keep API. Question 3. |
| 10 | **principal** → **actor** (UI copy) | Who did something: a person, an agent, an app or the platform. | GitHub's audit log says actor; "principal" is IAM jargon. Alternative: "account" (wrong for the platform itself). | Copy in UI and guides. Keep `/api/v1/principals`, `principalId`, the concept page URL. |
| 11 | **signal / reason / gate** → **reason** (and **Auto-merge checklist** for the gates) | Each reason says why a Change needs at least some lane; the highest one wins. | One word for one thing; the UI says "7 signals" above a list of reasons. Alternative: "check" (collides with GitHub checks). | Copy. Keep reason codes and `checklist`. |
| 12 | **claim** (category) → **category**; keep **claim** for ownership | Category: what the author says the Change is (fix, feature, …), an input, never the decision. Claim: a person takes ownership of a repo an agent created without an account. | One meaning per word. "Claim" for ownership matches Cloudflare's workers.new (the model for unclaimed repos) and Vercel's claimable deployments. | Copy. Keep `change.claim.category`, `claimUrl`. |
| 13 | **kill** (a Change) → **Switch off**; keep **kill switch** for the operator's | Switch off: turn a merged Change's flag off; the old code path is back in about 30 s, no deploy. | The rollout page says "Kill switch" and "Why are you killing this rollout?" while the landing says "One switch undoes one change". "Switch off" is calmer and says what happens. Alternative: "Turn off". | Copy. Keep `/changes/{id}/kill`, the `kill` action. |
| 14 | **revert** vs **roll back** (keep both, define) | Roll back: traffic goes back to the previous version. Revert: a new Change that undoes the commit. | The docs blur them: the statuses table defines `reverted` as "Rolled back after a regression". | Copy. |
| 15 | **Deploy train** → **Deploy batch** | A group of merged Changes that deploy together; the next starts when this one is done. | GitLab's "merge train" is a merge queue, so "train" misleads; "batch" matches the queue. | Copy. Keep `trains` in the API. |

Smaller fixes, copy only: one spelling **red/green proof** (kind `red-green` stays); **mutation
score** with a gloss at first use ("how many planted bugs the tests catch"); **model check** for
"judge"; and "verdict" kept only for a stop's proven / unproven / risk mark (a reviewer's lane
pick is "your pick", a GitHub result is "graded"). Keep as they are: evidence, merge queue,
track, batch, policy, rollout, flag, workspace, fork (define it: "your Change's own copy of the
repo"), stop, proposed setup.

## Before → after

### 1. Docs home glossary (`packages/docs/content/index.md`)

Before (8 terms):

```text
- Plan: what an agent intends to do and how to tell it worked. A person approves it before the work counts.
- Change: one unit of work, pushed to its own fork. The platform's version of a pull request.
- Evidence: signed results the platform records for a Change: CI steps, tests, red/green proof, API and dependency diffs.
- Lane: how much review a Change needs. 0 merges on its own, 1 needs a quick look, 2 needs a full review.
- Tour: a guided walk through a Change, written by a reviewer agent that didn't write the code.
- Merge queue: the only thing that writes the default branch. It tests Changes together before they land.
- Policy: the repo's rules for lanes, in .platform/policy.ts, always read from the default branch.
- Shadow mode: Lane 0 is computed but off. People review everything until their verdicts agree with the platform's.
```

After (10 terms, in the order a newcomer meets them):

```text
- Plan: what a Change is for and how to tell it worked. A person who didn't write it approves it first.
- Change: like a pull request, plus its proof. One unit of work, pushed to its own fork.
- Evidence: what the platform proves about a Change and signs: tests, red/green proof, coverage, API and dependency diffs.
- Lane: how much review a Change gets.
    Auto-merge (Lane 0): the evidence decides; nobody reviews.
    Quick review (Lane 1): a person reads the walkthrough and approves.
    Full review (Lane 2): a person reads the diff, with the walkthrough as a guide.
- Reason: why a Change needs at least a given lane. The highest reason wins; a missing signal only raises it.
- Walkthrough: a short guide to a Change by a second agent, riskiest part first, every stop tied to evidence.
- Merge queue: the only thing that writes the default branch. It tests Changes together before they land.
- Policy: the repo's rules for lanes, in .platform/policy.ts, always read from the default branch.
- Calibrating: auto-merge is off. People review everything until their picks agree with the platform's often enough.
- Report-only (GitHub): gittifacts grades each pull request but never blocks or merges it.
```

### 2. Change page header (`packages/web/src/routes/tour.tsx`, `LaneBlock`)

Before, a Change the evidence puts in Lane 0 while shadow mode is on:

```text
[1]  Lane 1 · Glance
     Evidence computes Lane 0. Shadow mode routes it to a person.
     ▸ Why Lane 1                                  6 signals
agent-7 (Dev Patel's) · Fix · updated 4m ago · +41 −12 in 3 files
[ Approve this change ]
```

After:

```text
[1]  Quick review · Lane 1
     The evidence qualifies it for auto-merge. Auto-merge is calibrating
     for this repo, so a person approves it (19 of 25 reviews so far).
     ▸ Why it needs a quick review                 6 reasons
agent-7 (Dev Patel's) · Fix · updated 4m ago · +41 −12 in 3 files
[ Approve change ]   Your pick, for calibration: ( Auto-merge ) ( Quick ) ( Full )
```

### 3. GitHub check run (`packages/host-github/src/check-run.ts`)

Before:

```text
gittifacts/lane · Neutral
Shadow · Lane 1: a quick look with a guided tour

**Shadow mode.** gittifacts graded this head. It never blocks, approves or merges anything here;
any tour is a comment-only review.
| Lane          | **1** |
| Computed lane | 0 (raised by policy) |
| Head          | `3f2a9c1d0b7e` |
| Evidence      | signed and verified (`ev_…`) |
| Tour          | ok |
### Why
- `shadow.lane0-disabled` (lane 1): …
[The tour, evidence and attestation on gittifacts](…)
Buttons: [Approve tour] [Request full review]
```

After (the check name, the conclusion and the parsed `| Lane |` row stay):

```text
gittifacts/lane · Neutral
Report-only · Quick review (Lane 1)

**Report-only.** gittifacts graded this head. It never blocks, approves or merges here; GitHub
still does. Its walkthrough is a comment-only review.
| Lane          | **1** (quick review) |
| Evidence alone | 0, auto-merge (auto-merge is calibrating) |
| Head          | `3f2a9c1d0b7e` |
| Evidence      | signed and verified (`ev_…`) |
| Walkthrough   | ready, 5 stops in the review below |
### Why
- `shadow.lane0-disabled` (Lane 1): auto-merge is calibrating on this repo.
[Walkthrough, evidence and signature on gittifacts](…)
Buttons: [Approve change] [Request full review]
```

Note for whoever implements this: `readCheckRunVerdict` reads `^\| Lane \| \*\*(\d)\*\* \|$`, so either
keep that row exactly or widen the regex first (old runs on GitHub keep the old text forever), and
accept both `Shadow · ` and `Report-only · ` as the title prefix. "Computed lane … (raised by
policy)" is also wrong when shadow mode, not policy, raised it; "Evidence alone" avoids the claim.

## Rollout order

**Step 1: copy only, highest value (one PR per surface, no API change).**
1. Lane names: one table drives every surface. `packages/web/src/lib/lanes.ts` (`LANES`),
   `host-github` `LANE_WORDS` and `LANE_WORD` (check-run.ts, pr-writes.ts; today they disagree on
   Lane 0), CLI `laneLine` (views.ts), `/start` `RULES` line (start.ts), docs `concepts/lanes.md`
   and the home glossary. Better: export one `LANE_LABELS` from `@app/domain` and import it
   everywhere, so the wordings can't drift again.
2. push grant → push token; bootstrap Change → first Change; "Approve tour" → "Approve change"
   (button label only; the action id stays `approve_tour`).
3. Change: fix the home vs concept-page contradiction; one case rule (capitalized in docs and app;
   landing too, or explicitly lowercase there).
4. Docs check: add a banned-terms list to the docs style check (`push grant`, `bootstrap Change`,
   `Glance`, `async glance`) so the old words don't creep back.

**Step 2: copy plus a tolerant reader.**
5. Shadow mode → Calibrating / Report-only. First widen `readCheckRunVerdict` to accept both title
   prefixes, deploy, then change the titles. Reason codes `shadow.*` keep their ids; only their
   messages change.
6. Tour → Walkthrough in UI, docs and GitHub text. Tool descriptions say "the walkthrough (tour)"
   so an agent that knows the old word still matches `get_tour`.
7. principal → actor; signal → reason; kill → Switch off; deploy train → deploy batch; claim
   (category) → category. UI and guide copy; reference pages generated from code keep field names.

**Step 3: aliases with a deprecation path (only if the user wants machine names to follow).**
8. `create_project` output gains `repoId` (same value as `projectId`); docs and next steps use
   `repoId`; `projectId` is documented as deprecated and kept for at least one CLI major version.
9. If Question 1 or 3 lands on a new noun for the API too: add the new field next to the old one,
   never rename in place; MCP tool names don't change (an agent's saved prompts and `/start` copies
   name them). `search_tools` can match old words to new tools instead of adding duplicate tools.

**Leave alone.** Every MCP tool name; every API path and field (`/changes`, `/plans`, `lane`,
`computedLane`, `shadow`, `claim`, `tour`, `stops`); the 106 reason codes; the check name
`gittifacts/lane` (owners list it as a required check in their rulesets; renaming it silently
un-requires it); check conclusions (`action_required` is GitHub's enum); fork names `task-<id>`,
flags `change-<id>`, the `gittifacts-plan:` PR-body marker and `gittifacts:<category>` labels;
the docs URLs (`concepts/tours`, `concepts/unclaimed-projects`, `concepts/principals-and-scopes`):
retitle the pages, keep the paths.

Coordinate with the agents working on GitHub PR copy and the dashboard: steps 1, 2 and 5 touch
`packages/host-github/src/{check-run,pr-writes}.ts` and `packages/web/src/lib/lanes.ts`.

## Questions for the user

1. **Lane labels.** Lead with names ("Quick review · Lane 1") or drop the numerals from the UI
   entirely? And is "Quick review" right for Lane 1, or keep "Glance"?
2. **Shadow mode.** Split it into "Calibrating" (native) and "Report-only" (GitHub)? For GitHub,
   "Report-only", "Evaluate" (GitHub rulesets' word) or "Advisory"?
3. **Plan.** Keep "Plan", or move to "Spec"? (Proposal: keep it. It is in every tool and URL, and
   the problem is case and definition, not the word.)
4. **project vs repo.** Retire "project" in copy and alias `projectId` → `repoId`? Or keep
   "project" as the bigger thing (repo + CI + previews + deploy target), Vercel-style?
5. **Tour.** Rename the label to "Walkthrough", or keep "tour" as a brand word and only fix
   "Approve tour"?
6. **Change.** Confirm the one-line definition: "like a pull request, plus its proof".
7. **Machine names.** Labels only (proposed), or should tool names and fields follow with aliases?
