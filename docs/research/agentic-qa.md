# Agentic QA, on request (design, 2026-10-04)

Where it sits: human writes the Plan → an agent implements → the reviewer agent writes the walkthrough
→ **QA, when someone asks** → a human decides. An agent drives the app built from the Change's head in a
real browser against the Plan's acceptance criteria, and leaves signed evidence: screenshots per step,
a short replay GIF, console and network errors, and a verdict per criterion (pass / fail / couldn't test).
QA never runs on its own. It never lowers a lane; a failure raises it.

## 1. Trigger (on request only)

| Where | How | Who may |
|---|---|---|
| Change page | "Run QA" button in the QA section | the author or a repo member with role ≥ reviewer |
| MCP | `request_qa({ changeId \| github, force? })`, `get_qa({ changeId \| github })` | same, as the agent's principal |
| CLI | `gittifacts qa <change> [--github owner/repo#n] [--wait] [--force]` | same |
| HTTP | `POST /api/v1/changes/{id}/qa`, `GET /api/v1/changes/{id}/qa` | same |
| GitHub | check-run button **Run QA** (`run_qa`, 6 chars), or a PR comment `/gittifacts qa` | a GitHub user with write access, re-checked with GitHub on every press (as the existing buttons) |

- **Idempotent per head.** One run per (Change, head SHA). Asking again returns that run (`reused: true`),
  unless `force` and the last run finished (a re-run is a new run id for the same head).
- **Rate limit per repo:** ≤ 6 runs per hour and ≤ 30 per day (D1 count over `qa_runs`), one in flight per
  Change. Over the limit: `429` with `retryAfterSec` (HTTP/MCP), a refused audit entry on GitHub.
- **Preconditions:** the head has green CI with a `build` (or `install`) snapshot. Otherwise the request is
  answered with what is missing (`no-build`), and nothing runs.

## 2. Isolation: a private preview reached only through the Worker (decision)

Previews are off for GitHub repos because a preview URL is a public capability URL. QA must not add one.
Options weighed:

| Option | Leak risk | Cost | Verdict |
|---|---|---|---|
| a. Headless browser inside the sandbox container | none | a Chromium in the sandbox image (+~400 MB), a new exec protocol for steps, screenshots out through the Runner | heavy; the Runner image is shared by CI |
| b. Access-gated preview + short-lived token only Browser Run presents | low: a token in a URL or cookie can leak (logs, Referer, third-party requests) | small | the preview is still on the public internet |
| c. Browser Run with an injected auth header | low-medium: `setExtraHTTPHeaders` sends it to every origin the page calls | small | leaks to third parties |
| **d. Browser Run + request interception, the app served by the Worker** | **none: the app has no public address** | small | **chosen** |

**d, how it works.** The QA run boots the head in the same sandbox container a preview uses (`PreviewHost`
Durable Object, CI build snapshot, `enableInternet: false`), under its own name `q-<changeId>-<sha8>` and with
**no `previews` row**, so the public preview gateway can't route to it (it only serves `p-` labels with a
row). Browser Run opens a real Chromium (`@cloudflare/puppeteer`), and every request the page makes is paused
over CDP (`page.setRequestInterception(true)`) and answered **by the Worker**: requests to the app origin are
fetched from the `PreviewHost` DO over its binding and fulfilled with `request.respond()`; requests to any other
origin are aborted and recorded as `blocked`. The app origin is `https://q-<changeId>-<sha8>-pv.resynapse.dev`;
if interception ever failed open, that host reaches the gateway, which answers 404 for a `q-` label (fail
closed). Nothing is public, there is no token to leak, and untrusted code (fork PRs) stays in the same sandbox
as today (no internet in the container; in the browser, no origin but its own).

Consequences: third-party scripts, fonts and APIs don't load during QA (recorded per run; a criterion that
depends on them is "couldn't test"). Every app request costs a CDP round trip through the Worker (fine for the
small apps QA targets). The same path is used for native repos, so there is one code path.

## 3. The agent loop (`@app/qa`, pure over two ports)

`@app/qa` holds the loop, the step DSL, the prompts and the verdict rules. It talks to a `QaBrowser` port
(the platform implements it with Browser Run; tests with a fake) and to the reviewer's `LlmClient`
(`@app/tour`, the platform default model `@cf/zai-org/glm-5.3-flash`, low reasoning effort).

1. **Criteria.** The Plan's `acceptanceCriteria` (≤ 8 per run; the rest are "couldn't test: over the run's
   budget"). No Plan → one smoke criterion: "the affected routes load without errors" (`source: "smoke"`).
2. **Routes.** Plan `affectedRoutes`, the template's routes, routes guessed from changed files (`public/x.html`
   → `/x.html`, `src/routes/foo.tsx` → `/foo`), then `/`. At most 4.
3. **Explore.** Open each route; take a compact snapshot: title, URL, visible text (≤ 1.5 KB) and up to 40
   interactive elements with a stable selector each (`#id`, `[data-testid]`, `[name]`, else role + text).
4. **Plan the scripts (1 LLM call).** Input: criteria, route snapshots, changed file paths (never the
   author's summary). Output (json_schema, zod-validated): per criterion a start route and ≤ 10 steps,
   or `untestable` with a reason. Steps: `goto`, `click`, `fill`, `press`, `select`, `wait`, `expect_text`,
   `expect_no_text`, `expect_visible`, `expect_url`, `expect_count`.
5. **Run.** Per criterion from a fresh page: a "before" screenshot, then each step (5 s timeout) with a
   screenshot after it. Console errors, page errors, and requests answered ≥ 400 or blocked are recorded.
6. **Repair (≤ 1 LLM call per criterion).** An *action* that can't find its target gets one rewrite of the
   remaining steps from the current snapshot. A failed *expectation* is never repaired: it is the answer.
7. **Traceability (no model).** Each expectation is checked against its criterion's own text
   (`packages/qa/src/trace.ts`): every number it expects must appear in the criterion (as a value: `€100.00` =
   `100`, "three" = `3`); expected text must be a quoted string of the criterion or use only its words; a
   count must be one of its numbers; a selector or URL must name one of its words. Only traced expectations
   decide; an untraced one still runs, and if it doesn't hold it becomes an "also observed" note.
8. **Verdict.** Deterministic first: a failed expectation → `fail`; an action still failing after repair, or
   no expectation at all → `couldnt-test`; otherwise `pass`. Then **one LLM review** of all criteria
   (steps, results, final page text) may only cast doubt on a pass (pass → couldn't test): `fail` always
   comes from a failed expectation in the browser, and nothing turns a fail or a couldn't-test into a pass.
   (Live, an unrestricted review failed a criterion that held because of another criterion's bug.)
9. **Replay.** The step screenshots (JPEG, half scale) become an animated GIF, encoded inside the same
   Chromium (canvas + a small GIF encoder evaluated in the page), so the Worker does no image work.

## 4. Evidence: a signed `qa-run` item

Added to `@app/evidence` (standalone) and to the head's bundle by resealing it (as screenshots are), so the
platform signature covers it and `gittifacts-verify` checks it like any item.

```ts
QaRun = {
  id: "qa-run", kind: "qa-run", status: "ok" | "skipped" | "error", note?,
  runId, trigger: "platform" | "mcp" | "cli" | "github-check" | "github-comment", requestedBy,
  app: { source: "private-preview", snapshotStep: "build" | "install", origin },
  model, promptVersion,                              // e.g. "@cf/zai-org/glm-5.3-flash", "qa/1"
  criteria: [{ index, text, source: "plan" | "smoke",
               verdict: "pass" | "fail" | "couldnt-test", reason,
               steps: [{ action, target?, value?, ok, detail?, shot? /* artifact name */ }],
               consoleErrors, networkErrors }],
  artifacts: [{ name, ref /* R2 key */, sha256, bytes, contentType,
                role: "before" | "step" | "thumb" | "recording" | "log" }],
  blockedOrigins: string[],
  usage: { wallMs, browserMs, llmCalls, inputTokens, outputTokens, llmUsd },
}
```

Artifacts live in R2 under `qa/<changeId>/<runId>/`; their SHA-256 is in the signed item, so a swapped
screenshot no longer matches. `status: "error"` means the run itself failed (browser, boot, model).

**Lane effect (classifier, pure).** New gate `qa` with reasons: `qa.not-requested` / `qa.passed` (Lane 0,
never lower anything), `qa.couldnt-test` (Lane 1, unknown: a requested check didn't conclude),
`qa.failed` (Lane 2, fail), `signal.error.qa` (Lane 1, unknown). `classify()` reads the item when present;
`raiseForQa(previous, item)` applies the same rules to a stored classification without re-running the rest,
and can only keep or raise (it is `neverLower` with QA's reasons). Absent QA never raises anything: QA is opt-in.

## 5. Posting to GitHub, quietly

- **No new comments.** The one summary comment (owned by the PR-presentation work in `host-github`) gets an
  optional QA section through one interface: `SummaryState.qa?: QaView | null`, rendered by
  `qaSummaryLines()` in `packages/host-github/src/qa-section.ts` (ours). One headline line ("**QA** · 3 passed,
  1 failed · [report]") and a `<details>` with each criterion, its verdict and up to 4 thumbnails.
  A Lane 0 PR has no summary comment and QA doesn't create one; its check run carries the result
  (a QA failure raises the lane, and then the summary appears as for any PR that needs a person).
- **The check run** is re-completed with the (possibly raised) verdict and a QA fold in `output.text`.
- **Images.** GitHub has no documented API for an App to upload attachments: the browser upload
  (`/upload/policies/assets`) needs a user session, and `gh … --attach` (GitHub CLI 2.99, changelog
  2026-09-01) authenticates with the `gh auth login` OAuth token or a classic PAT, not an installation
  token. GitHub renders comment images through Camo, which must fetch them from a public URL
  ("If an image is being served from a private network or from a server that requires authentication, it
  can't be viewed by GitHub", docs: About anonymized URLs). So: **thumbnails only** (≤ 400 px wide JPEG),
  served by the platform at `/qa-img/<runId>/<name>?exp=…&sig=…`, HMAC-SHA-256 under a key derived from
  `BETTER_AUTH_SECRET` ("gittifacts/qa-image/v1"), valid **72 hours**, then `410`. Each thumbnail links to the
  full report on gittifacts (sign-in and repo membership required), where full-size steps and the GIF live.
  Whoever can read the PR can open a thumbnail while it lives; that is the same audience as the PR.
- Writes per QA run: ≤ 1 check-run PATCH + ≤ 1 summary edit, through the installation's write gate.

## 6. Native mode

The Change page gets a QA section: "Run QA", status while it runs, each criterion with its verdict and reason,
a strip of step screenshots (tap for full size), the replay GIF, console/network errors, cost and time.
When the run ends, a `qa-finished` notification goes to the repo's humans (the notifications table every other
notice uses); a failure also says the lane was raised.

## 7. Budgets and costs

| Budget | Default | On hitting it |
|---|---|---|
| Wall time per run | 5 min | remaining criteria → couldn't test ("over the run's time budget") |
| Browser time per run | 3 min | same |
| Model spend per run | $0.05, and it counts against the Change's AI budget (`ai.budgetUsdPerChange`) | no more model calls; verdicts stay deterministic |
| Criteria / steps | 8 per run, 10 steps per criterion, 1 repair each | the rest → couldn't test |
| Screenshots | 60 per run | later steps run without a screenshot |
| Runs per repo | 6 per hour, 30 per day, 1 in flight per Change | 429 / refused |

Expected cost per run (measured in §9 after deploy): ~3–6 model calls on GLM-5.3-Flash ($0.15/M in,
$0.50/M out) ≈ $0.002–0.01; Browser Run ~1–2 browser-minutes (10 h/month included on Workers Paid, then
$0.09/h ≈ $0.003/run); the container is the preview container (standard-1) for a few minutes.

## 8. Code map

- `packages/evidence`: `QaRun` schema. `packages/classifier`: gate `qa`, reasons, `raiseForQa`.
- `packages/qa` (new): criteria, routes, step DSL, prompts, `runQa()` loop over `QaBrowser` + `LlmClient`.
- `apps/platform/src/qa/`: `QaRunWorkflow`, Browser Run driver (interception → `PreviewHost`), request
  service + routes, signed thumbnails, D1 `qa_runs`, GitHub glue. `packages/host-github`: `run_qa` button,
  `/gittifacts qa` comment, `qa-section.ts`. `packages/mcp` / `packages/cli`: `request_qa`, `get_qa`, `qa`.
  `packages/web`: the QA section on the Change page.
- Tests: `@app/qa` loop over a fake browser + fake model (verdict rules, never-raise-to-pass); classifier
  unit tests (pure); workerd integration (request → workflow → real `PreviewHost` over the private path →
  signed item → lane raised → notification; idempotency, rate limit, access); host-github (button, comment,
  permission re-check, summary section); E2E in `apps/e2e` (the Change page QA section).

## 9. Open

- `/gittifacts qa` needs the App to subscribe to the **Issue comment** event (no new permission: issues and
  pull requests are already granted). Until it is ticked in the App settings, the button is the GitHub trigger.
- A re-grade of the same head (new CI run) drops the `qa-run` item from the new bundle; the run stays in
  `qa_runs` and the page shows it, but the lane no longer carries it.
- A QA failure after a human approved does not withdraw the approval; it raises the lane and notifies.
