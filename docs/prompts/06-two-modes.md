# Build: two modes — on top of GitHub, and native on Artifacts

This prompt adds to the platform build. The repo already contains (or is building) the platform described in the main
build prompt and its follow-ons (onboarding, merge queue): Changes, Plans, signed evidence, risk lanes, guided tours,
merge queue, rollout and automatic revert, on Cloudflare. Read `STATUS.md`, `DECISIONS.md` and those prompts first.

The platform must now run in **two modes over one shared core**:

- **GitHub mode.** Code stays on GitHub. The platform installs as a GitHub App and grades every PR. For each PR it
  decides whether it can merge on its own, needs a quick glance with a guided tour, or needs a full review. It shows
  evidence and tours inside GitHub, and (if allowed) merges and reverts.
- **Native mode.** Cloudflare Artifacts is the source of truth. This is the platform as already specified.

Both modes must give **the same lane, the same evidence and the same tour for the same change**. Only the plumbing
differs.

Work autonomously. Stop only for the conditions at the end.

## 1. Why two modes
- **GitHub mode is the way in.** Teams won't move their repos to try a review tool. They will install an app. It must
  prove itself on their real PRs, starting in shadow mode, with no change to their workflow.
- **Native mode is the destination.** Things GitHub can't do well (git-notes evidence, agent-resolved conflicts in our
  own queue, sandboxes that start instantly via ArtifactFS, agents as first-class users) only work fully there.
- **A clean migration path connects them.** A repo can move from GitHub mode to native mode, with GitHub kept as a
  read-only mirror.

## 2. Architecture: core + host adapters
Refactor so the domain never knows which host it runs on.

```
@app/core        Change, Plan, Evidence, classifier, tour, policy, queue core   (pure, host-agnostic)
@app/evidence    evidence engine + signing (already standalone)
@app/host        HostAdapter interface + normalized events + capability flags
@app/host-artifacts   native adapter (Artifacts, own merge queue, git-notes)
@app/host-github      GitHub App adapter
```

```ts
interface HostAdapter {
  capabilities(): HostCapabilities
  getChange(ref): Promise<ChangeMeta>            // author, title/body, base/head SHAs, linked plan refs
  materialize(ref, sha): Promise<SandboxCheckout> // get a tree into a sandbox (see §3.3)
  diff(ref): Promise<DiffInfo>
  publishVerdict(ref, verdict: LaneVerdict): Promise<void>
  publishTour(ref, tour: Tour): Promise<void>
  requestReview(ref, reviewers): Promise<void>
  merge(ref, { expectedHeadSha, method }): Promise<MergeResult>   // must be guarded by expectedHeadSha
  revert(mergedSha, reason): Promise<ChangeRef>
  events(): normalized stream: change.opened | change.updated | change.closed |
            review.submitted | main.advanced | queue.group_created | ...
}
interface HostCapabilities {
  canMerge: boolean; canPushToChangeBranch: boolean; hasOwnMergeQueue: boolean;
  hasHostMergeQueue: boolean; supportsNotes: boolean; supportsInlineTourStops: boolean;
  identityKinds: ('human' | 'agent' | 'bot')[]
}
```

The core reads `capabilities()` and degrades explicitly: e.g. if `canMerge` is false, Lane 0 becomes "ready to merge,
labelled" instead of merging. Every degradation is visible in the verdict, never silent.

**Contract test suite.** One set of fixture scenarios runs against **both** adapters: `pure-bugfix-with-regression-test`,
`breaking-api`, `new-dependency`, `touches-auth`, `codemod-rename`, `scope-drift`, `fork-pr`, `force-push-during-eval`,
`stale-head-at-merge`. Lanes and evidence must match exactly across modes. GitHub runs against a dedicated test org
(live, nightly) plus recorded webhook/API fixtures (fast, every commit).

## 3. GitHub mode
All GitHub API behaviour below must be **checked against GitHub's current docs before implementing**: rulesets and bypass
actors, whether App reviews count toward required approvals, the `merge_group` event, auto-merge via GraphQL, check run
output limits, rate limits, fine-grained App permissions. Record what you find in `DECISIONS.md`.

### 3.1 Install and permissions
- A GitHub App with **least privilege by default**: metadata read, contents read, pull requests write
  (comments/reviews), checks write, issues read (for linked Plans).
- **Escalated permissions are opt-in per repo**, requested only when the owner turns the feature on:
  contents write (Lane 0 merge, pushing resolver commits, revert PRs); workflows read (reading Actions results).
- Webhooks go through a Worker: verify the signature, enqueue to Cloudflare Queues, process idempotently by delivery ID.
  A Durable Object per PR coordinates (the same Change coordinator as native mode).
- Respect rate limits per installation: prefer webhooks over polling, use conditional requests, batch with GraphQL,
  back off on secondary limits.

### 3.2 Grade every PR, human- or agent-written
- Map each PR to a `Change`. Record the author kind: human, a known coding agent (bot accounts, `Co-Authored-By`
  trailers, branch/label conventions of common agents; configurable list), or another bot (Dependabot/Renovate).
- The lane logic is the same for every author kind. Author kind is an *input* to the outcome prediction, never a way
  past the gates.

### 3.3 Evidence without moving the repo
- An **Artifacts mirror per GitHub repo** as a read-through cache for compute: fetch PR heads/bases incrementally with
  the installation token; sandboxes mount it via ArtifactFS. GitHub stays the source of truth; the mirror is disposable.
- Run the full evidence engine on Cloudflare: red/green, public API diff, dependency diff, sensitive paths, changed-line
  coverage, mutation score, preview + screenshots (if the repo deploys to Workers, else skipped with a reason),
  reproducible transforms.
- **Use GitHub Actions results too:** read their check runs as extra evidence, but don't depend on them. Required
  evidence always comes from our own runs (reproducible, signed).
- Store evidence in D1/R2 with the signed attestation; link it from the check run. Don't push git-notes to GitHub.

### 3.4 Show it inside GitHub (and keep the noise down)
- **One check run per PR** named `<platform>/lane`: success = Lane 0 eligible; neutral = Lane 1; action_required =
  Lane 2. Summary: lane, top reasons, evidence table, link to the full tour UI. Check run actions (buttons) for "Approve
  tour" and "Request full review" where the API supports them.
- **The tour lives in a single PR review** with event `COMMENT`: inline comments anchored to the riskiest hunks (one per
  tour stop), plus `leastConfident` / `notDone` in the review body. Lane 0 gets **no** review comments, only the check run.
- **One sticky PR comment at most**, edited in place, never re-posted. When a new head arrives, update everything in
  place, and mark tour stops whose hunks changed as stale.
- Humans approve a tour from the platform UI (mobile-first) or by approving the PR on GitHub; both map to the same
  approval record.

### 3.5 Plans on GitHub
A Plan can come from (a) a linked issue (`Closes #N`) with an approval label applied by an allowed maintainer, (b) a
`.platform/plans/<id>.md` file approved through the platform UI, or (c) a Plan created on the platform and referenced in
the PR body. Without an approved Plan there is no Lane 0, except for opted-in policy categories (e.g. Dependabot/Renovate
patch bumps with green proof).

### 3.6 Acting: merge, queue, revert
- **Shadow mode is the default and must stay frictionless:** grade, post check runs and tours, merge nothing. Show the
  "would have auto-merged" rate and the classifier/human agreement.
- **Lane 0 merge (opt-in):** merge via the API with an expected-head-SHA guard, or enable GitHub auto-merge. Document the
  interaction with branch protection, rulesets and required reviews (e.g. the App as a bypass actor). The setup wizard
  explains exactly which ruleset change is needed and why. **Never** recommend turning off protection for humans.
- **Merge queue:** with **GitHub's merge queue**, act as a required check on `merge_group` events: re-run the cheap
  evidence on the merge-group tree ("evidence describes what lands") and re-check the lane. Our own queue is native-only
  in v1. In GitHub mode the resolver may push resolution commits to the PR branch **only** when
  `canPushToChangeBranch` is true (same-repo branches, or fork PRs with maintainer edits allowed). Same lane rules.
- **After merge:** pluggable `SignalSource`s: Workers Issues (if the app deploys to Workers), a generic webhook
  (Sentry etc.), GitHub deployment statuses. A regression attributed to a PR → open a **revert PR** automatically,
  labelled and linked; merge it automatically only if the repo enabled it.

### 3.7 Backtest on install (the "aha" moment)
Grade the last N merged PRs on install (default 90 days, capped by rate limits and budget). Correlate with later
reverts and fix PRs touching the same lines within 14 days. Report: "X% would have auto-merged"; "of those, Y were later
reverted or patched" (must be low, or the classifier gets tightened); "here are the 3 PRs we'd have sent to full review
that you merged quickly". This also calibrates the classifier per repo before Lane 0 can be enabled.

### 3.8 Security in GitHub mode
- **Fork PRs are untrusted code**: sandboxes without secrets or network beyond package registries; never write-scoped
  tokens; never `pull_request_target`-style pitfalls.
- Installation tokens are short-lived, scoped to one repo per job, never exposed to sandboxes, never logged.
- The App never approves a PR as a GitHub review that counts toward human-required approvals, unless the owner
  explicitly configured that via the documented ruleset path. Even then, no self-approval: an agent-authored PR can't be
  approved by an agent principal.

## 4. Native mode
The platform as already specified, moved behind `@app/host-artifacts` with no change in behaviour (the contract suite
proves it).

## 5. Graduation: GitHub mode → native mode
`graduate({ repo })`: (1) import into Artifacts (the mirror becomes primary), (2) freeze merges on GitHub briefly
(ruleset or branch lock), (3) final sync, (4) switch the source of truth, (5) GitHub becomes a **one-way, read-only
mirror** (push main and tags after every merge; new GitHub PRs get a "please open this on <platform>" bot comment, or are
imported as Changes if the owner chooses). **Never bidirectional sync.** One source of truth at any moment; the switch is
an audited event. Dry run + documented rollback.

## 6. Onboarding in each mode
- **GitHub:** one-click install → first PR graded within 2 minutes → backtest report within 15 minutes. The MCP tools
  work in GitHub mode too, e.g. `get_change_status({ github: "owner/repo#123" })`, `get_tour`, `wait_for_change`.
- **Native:** unchanged.

## 7. Milestones (each ends green and deployed)
- **M1 – Extract the core.** `@app/core` + `HostAdapter` + `@app/host-artifacts`; native behaviour unchanged; the
  contract suite runs against the native adapter.
- **M2 – GitHub App, shadow grading.** Install, webhooks → Queues → Change coordinator, Artifacts mirror, evidence,
  `<platform>/lane` check run; contract suite passes against GitHub (recorded fixtures + nightly live test org).
- **M3 – Tours in GitHub + Plans.** Single review with inline stops, sticky comment, stale stops, plan linking,
  approvals from GitHub and the platform UI.
- **M4 – Backtest report + per-repo calibration.**
- **M5 – Acting in GitHub.** Opt-in Lane 0 merge + ruleset wizard, required check on `merge_group`, resolver pushes
  when allowed, signal sources, revert PRs.
- **M6 – Graduation.** Dry run, cutover, read-only GitHub mirror, rollback.

## 8. Non-goals
Bidirectional sync; GitLab/Bitbucket adapters (keep the interface host-agnostic); replacing GitHub Actions; more than one
comment thread per PR.

## 9. When to stop and ask
- GitHub's current rules make Lane 0 impossible without weakening branch protection for humans.
- An escalated permission is needed that isn't in §3.1.
- The contract suite shows a lane/evidence mismatch between modes that can't be fixed without changing the product rule.
- Costs beyond the dev tier (e.g. backtesting large repos), or beta access you can't get.

For everything else, decide, record it in `DECISIONS.md`, and keep going.
