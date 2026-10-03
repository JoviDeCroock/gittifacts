# GitHub App + API rules for GitHub mode (verified 2026-10-03)

Everything below was checked on 2026-10-03, read-only. Nothing on GitHub was created, changed or deleted. Source tags:

- **[D:x]** `https://docs.github.com/en/x`, fetched as markdown via `docs.github.com/api/article/body?pathname=/en/x`
- **[OAS]** `github/rest-api-description` `descriptions/api.github.com/api.github.com.json` @ main (REST API version `2026-03-10`)
- **[CL:x]** `https://github.blog/changelog/x`
- **[EMP:x]** third-party empirical reports. These are not GitHub-authored, so treat them as "verify on the test org".
- **[LIVE]** read-only `gh api` / GraphQL calls made with the user's token

Shorthands: `RS` = `repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets`,
`PB` = `repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches`.

## 0. TL;DR

1. **Lane 0 is possible without weakening protection for humans.** The default is two layered rulesets. The App is a bypass actor (`Integration`, `bypass_mode: pull_request`) **only** on the ruleset that holds the approval count. CI checks, code-owner review, force-push and deletion live in a second ruleset that nobody bypasses, the App included. The App merges **directly**, with a head-SHA guard and `bypass_rules: true`. Humans see no rule change (§2).
2. **Bypass is honored only by direct merges.** Auto-merge and the merge queue never honor it [EMP:community#208718, github/docs#45265 (open)]. So on merge-queue repos, Lane 0 needs the **approval path** instead. The App submits `APPROVE`, which counts only when the installation has `contents: write` [EMP]. GitHub itself now ships the same pattern for Copilot (opt-in, path-scoped) [CL:2026-09-01].
3. **New since the spec: `PUT /pulls/{n}/merge-async`** went GA on 2026-10-01. It handles a guarded direct merge, an explicit `bypass_rules`, and enqueueing. The sync `/merge` endpoint now says to use it, and that it "does not support stacked pull requests or merging with a merge queue" [D:rest/pulls/pulls].
4. **§3.1 is wrong about "workflows read".** The `workflows` permission is **write-only** and only covers editing `.github/workflows`. Actions check runs are readable with `checks` (we already hold write). `actions: read` is needed only for runs, logs, artifacts and `workflow_run` [OAS app-permissions].
5. **Permissions are per installation, not per repo.** "Opt-in per repo" therefore means a second "actor" App installed on selected repos only (§7).
6. **Features in §3.6 need permissions §3.1 doesn't list:** `merge_queues: read` (the `merge_group` webhook), `deployments: read` (`deployment_status`), maybe `statuses: write` (pinning the check source), and `workflows: write` for reverts that touch workflow files. This is a stop-and-ask candidate (§9).
7. **Check run limits:** summary and text are each 65,535 chars, annotations are capped at 50 per request (they append across PATCHes), and there are at most 3 action buttons (label ≤20 chars, description ≤40, identifier ≤20). Buttons appear only after the run completes. The `requested_action` event needs `checks: write`.
8. **Rate limits:** each installation gets 5,000 req/h (+50 per repo over 20, +50 per user over 20, capped at 12,500). The same numbers apply in GraphQL points. Secondary limits are 100 concurrent, 900 REST points/min, 2,000 GraphQL points/min, **80 content writes/min and 500/h**. A `304` doesn't count. Tokens expire after 1 h, can be scoped with `repository_ids` and `permissions`, and are now **~520-char stateless tokens**.
9. **Backtest cost is small.** vercel/next.js had 1,404 merged PRs in 90 days, and listing them costs about 45–400 GraphQL points [LIVE]. GraphQL `blame` is 1 point per file, but nesting the PR lookup per range **times out (>10 s)**. Do line history on the mirror instead.

## 1. Permissions (repository-level, installation tokens)

| Capability | Endpoint(s) | Permission | Tier |
|---|---|---|---|
| Repo metadata, collaborator permission check, **read rulesets / effective rules** | `GET /repos/{o}/{r}/collaborators/{u}/permission`, `GET /repos/{o}/{r}/rulesets[/{id}]`, `GET /repos/{o}/{r}/rules/branches/{b}` | `metadata: read` | default |
| Git fetch (mirror), compare, commits, branch (`protected`, `required_approving_review_count`) | git smart HTTP, `GET …/compare/{basehead}`, `GET …/branches/{b}` | `contents: read` | default |
| Check runs: create/update/rerequest, **and read every app's runs incl. Actions** | `POST/PATCH …/check-runs`, `GET …/commits/{ref}/check-runs` | `checks: write` (⊇ read) | default |
| Tour review + inline comments, PR labels, **sticky comment (issue-comment API on a PR)**, update-branch | `POST …/pulls/{n}/reviews`, `PATCH …/issues/comments/{id}`, `POST …/issues/{n}/labels`, `PUT …/pulls/{n}/update-branch` | `pull_requests: write` (issue-comment and label endpoints accept Issues **or** Pull requests, the "✓ additional permissions" column) | default |
| Linked-Plan issues + `issues.labeled` | `GET …/issues/{n}`, timeline | `issues: read` | default |
| **Merge** (sync and async), **create branch/commits for revert PRs**, resolver pushes | `PUT …/pulls/{n}/merge`, `PUT …/pulls/{n}/merge-async`, `GET …/merge-async/{uuid}`, `POST …/git/refs`, git push | `contents: write` | opt-in |
| Enable auto-merge (GraphQL `enablePullRequestAutoMerge`) | GraphQL | `contents: write` + `pull_requests: write` [EMP:objectstack-ai/objectstack#19762]. Fails with "without `workflows` permission" if the PR touches `.github/workflows` [EMP:Osasuwu/jarvis#1234] | opt-in |
| Receive `merge_group` | webhook | `merge_queues: read` ("To subscribe to this event, a GitHub App must have at least read-level access for the "Merge queues" repository permission." [D:webhooks/webhook-events-and-payloads#merge_group]) | opt-in, **not in §3.1** |
| Actions runs, jobs, logs, artifacts + `workflow_run` | `GET …/actions/runs[/{id}/jobs]` | `actions: read` | opt-in |
| Commits that touch `.github/workflows/**` (revert or resolver) | git push, `PUT …/contents` | `workflows: write` (write-only permission) | **avoid**: refuse such commits |
| `deployment_status` signal source | webhook, `GET …/deployments/{id}/statuses` | `deployments: read` | opt-in, **not in §3.1** |
| Third-party CI commit statuses as evidence | `GET …/commits/{ref}/status` | `statuses: read` | opt-in, **not in §3.1** |
| Create/update rulesets, read classic BP, `repository_ruleset` webhook | `POST/PUT …/rulesets`, `GET …/branches/{b}/protection` | `administration: read/write` | **never request**. The wizard emits JSON and the owner applies it |

Quotes. "Write permission for the REST API to interact with checks is only available to GitHub Apps" [D:rest/checks/runs]. The Workflows permission exists so that "If your app specifically needs to access or edit Actions files in the `.github/workflows` directory, request the "Workflows" repository permission" [D:apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app#choosing-permissions-for-git-access]. On ruleset reads: "the `bypass_actors` property is only returned if the user making the API request has write access to the ruleset", but `current_user_can_bypass` (`always|pull_requests_only|never|exempt`) is returned on the repo-level endpoint [OAS]. **The App can therefore self-check its bypass with `metadata: read`.**

### 1.1 Output limits

| Object | Limit | Source |
|---|---|---|
| check run `output.summary`, `output.text` | "**Maximum length**: 65535 characters" each (Markdown) | [OAS] create-check-run |
| annotations | "a maximum of 50 per API request … Each time you update the check run, annotations are appended". Message and raw_details ≤64 KB, title ≤255 | [D:rest/checks/runs#update-a-check-run] |
| `actions` (buttons) | "A maximum of three actions are accepted." label ≤20, description ≤40, identifier ≤20 chars. "The button created in this object is displayed after the check run completes." | [D:rest/checks/runs], [OAS] |
| check runs with the same name per suite | 1,000 (older ones are auto-deleted) | [D:rest/checks/runs#create-a-check-run] |
| incomplete run | becomes `stale` after 14 days. Only GitHub sets `stale` | [D:rest/guides/using-the-rest-api-to-interact-with-checks] |
| checks retention | 400 days | same |
| review comments per review | **not documented**. Cap tour stops at ~20 (secondary limits) | [D:rest/pulls/reviews] |
| comment / review body | 65,536 chars (API 422 text, not in the reference) | observed |
| PR files list | "a maximum of 3000 files" | [D:rest/pulls/pulls#list-pull-requests-files] |

Conclusions are `action_required|cancelled|failure|neutral|success|skipped|timed_out` (`stale` is GitHub-only). "Required status checks must have a `successful`, `skipped`, or `neutral` status" [D:PB/about-protected-branches#require-status-checks-before-merging]. So **`neutral` (Lane 1) passes a required check and `action_required` (Lane 2) blocks it.**

Reviews: a submitted review **cannot be deleted** ("Submitted reviews cannot be deleted" [OAS]). Its body can be edited (`PUT …/reviews/{id}`), inline comments can be edited (`PATCH …/pulls/comments/{id}`), and `PullRequestReview` is `Minimizable` (GraphQL `minimizeComment`) [LIVE introspection]. Pass `commit_id` = the graded head ("Not using the latest commit SHA may render your review comment outdated" [OAS]). Prefer `line`/`side` over `position`.

## 2. Lane 0 vs branch protection (question 2)

**Facts.**
- Who counts: "You can require approving reviews from people with write permissions in the repository or from a designated code owner" [D:RS/available-rules-for-rulesets#require-a-pull-request-before-merging]. **GitHub doesn't document App reviews.** Measured: an App `APPROVE` counts when the installation holds `contents: write`. "`giantswarm/roadmap#4349` measured that an App review with `contents: write` counts" [EMP:giantswarm/marge#121, 2026-09-17]. An App with `contents: read` posted `APPROVED` while GitHub "still reports REVIEW_REQUIRED" (`authorCanPushToRepository=false`) [EMP:aviaratech/ai-delivery#21, 2026-09-29]. Renovate's docs rely on approver Apps (`renovate-approve`) to satisfy mandatory reviews. First-party precedent: "When enabled, Copilot can submit an approval that counts toward the repository's required-approvals rule … off by default … choose which file paths Copilot is allowed to approve" [CL:2026-09-01-copilot-code-review-can-now-approve-pull-requests]. Authors can't approve their own PRs [D:pull-requests/…/approving-a-pull-request-with-required-reviews], so the App can't approve its own revert PRs. Team-based `required_reviewers` need team members, so an App can never satisfy them.
- Apps as bypass actors: "The following are eligible for bypass access: … GitHub Apps" [D:RS/creating-rulesets-for-a-repository#granting-bypass-permissions-for-your-branch-or-tag-ruleset]. REST: `actor_type: "Integration"`, `bypass_mode: always | pull_request | exempt`. "`pull_request` means that an actor can only bypass rules on pull requests … When `bypass_mode` is `exempt`, rules will not be run for that actor and a bypass audit entry will not be created." [D:rest/repos/rules]. UI: "For pull requests only … The selected actor is now required to open a pull request … The actor can then choose to bypass any branch protections and merge that pull request." Bypass is **per ruleset, not per rule**. Rulesets layer: "the rules in each of these rulesets are aggregated … the most restrictive version of the rule applies" [D:RS/about-rulesets#about-rule-layering].
- **Bypass reaches direct merges only.** Test matrix (rulesets and classic BP, both bypass modes, Apps and people): "Only the merge API honors the bypass. Auto-merge and the merge queue never do". `enqueuePullRequest` was "refused: 'At least 1 approving review is required…'". When the App also bypasses the queue rule, it "merged right away and skipped the queue completely" [EMP:community#208718, 2026-09-24]. Docs issue github/docs#45265 is still open ("needs SME").
- `merge-async` makes bypass explicit: "`bypass_rules` (boolean) Whether to bypass repository rules that the authenticated actor is permitted to bypass. Default: `false`". On `sha`: "if the PR is pushed in between the merge being requested and being executed, the merge will be cancelled" [D:rest/pulls/pulls#merge-a-pull-request-asynchronously].
- Availability. Rulesets: public repos on Free, and public + private on Pro/Team/GHEC [D:RS/about-rulesets]. In classic BP, "Actors may only be added to bypass lists when the repository belongs to an organization" [D:PB/about-protected-branches]. Merge queue: public org repos, or private org repos on GHEC [D:…/managing-a-merge-queue].

**Answer.** Yes, there are two paths that keep every human rule intact. A third path weakens protection and must not be recommended.

| Path | Setup | Works with | Human rules | Notes |
|---|---|---|---|---|
| **A. Split rulesets + bypass (default)** | Ruleset `human-review` holds only the approval rule, with bypass = actor App (`pull_request` mode). Ruleset `baseline` (no bypass) holds PR-required (0 approvals), required CI checks, code-owner review, no force push, no deletion | Direct merge (`merge-async` `direct_merge` + `bypass_rules:true`, or sync `/merge`) | unchanged | Not compatible with auto-merge or a **required** merge queue. Code-owner paths stay human-only by construction |
| **B. App approval counts (opt-in, per §3.8)** | Actor App with `contents: write` submits `APPROVE` with `commit_id` = graded head. Requires `dismiss_stale_reviews_on_push: true` | auto-merge, merge queue, `merge-async` `default` | unchanged (the App is one more write-access reviewer) | Lane 0 only when N=1 and there are no code-owner or team reviewers on touched paths. Otherwise degrade to "needs N−1 humans". Confirm with `reviewDecision == APPROVED` and `authorCanPushToRepository` |
| C. 0 approvals + `gittifacts/lane` as the gate | approvals → 0, our check required | everything | **weakened** (human PRs pass on our check alone) | Never recommend (§3.6) |

Path A rulesets (the wizard emits these; the owner imports them, and we never hold `administration`):
```jsonc
// human-review: the ONLY ruleset the actor App bypasses
{ "name": "human-review", "target": "branch", "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "bypass_actors": [ { "actor_type": "Integration", "actor_id": ACTOR_APP_ID, "bypass_mode": "pull_request" } ],
  "rules": [ { "type": "pull_request", "parameters": {
      "required_approving_review_count": 1, "dismiss_stale_reviews_on_push": true, "require_last_push_approval": true,
      "require_code_owner_review": false, "required_review_thread_resolution": false, "allowed_merge_methods": ["squash"] } } ] }
// baseline: nobody bypasses it, the App included
{ "name": "baseline", "target": "branch", "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "bypass_actors": [],
  "rules": [ { "type": "deletion" }, { "type": "non_fast_forward" },
    { "type": "pull_request", "parameters": { "required_approving_review_count": 0, "require_code_owner_review": true,
        "dismiss_stale_reviews_on_push": false, "require_last_push_approval": false,
        "required_review_thread_resolution": false, "allowed_merge_methods": ["squash"] } },
    { "type": "required_status_checks", "parameters": { "strict_required_status_checks_policy": true, "do_not_enforce_on_create": false,
        "required_status_checks": [ { "context": "ci/test" } /*, optional: { "context": "gittifacts/lane", "integration_id": APP_ID } */ ] } } ] }
```
- Leave `gittifacts/lane` **out** of `baseline` by default. Otherwise Lane 2 (`action_required`) blocks humans until we flip it, which makes our uptime a merge dependency. The actor enforces "own check `success` on this exact SHA" in code. If an owner adds it, pin `integration_id`: "you can select an app as the expected source … If the status is set by any other person or integration, merging won't be allowed" [D:RS/available-rules-for-rulesets#require-status-checks-to-pass-before-merging].
- If classic BP also requires reviews on the branch, ruleset bypass does **not** lift it, because both layers apply. The wizard detects this via `GET /branches/{b}` → `protected` / `required_approving_review_count` (contents:read). It then asks the owner to move the review rule into `human-review`.
- Lane 0 merge (actor App, token scoped to one repo with `{contents:write, pull_requests:write}`):
```http
PUT /repos/{o}/{r}/pulls/123/merge-async   {"sha":"<graded head>","merge_action":"direct_merge","merge_method":"squash","bypass_rules":true}
→ 202 {"status":"pending","details":{"uuid":"…","expected_head_sha":"…","bypass_rules":true}}  | 409 = another request pending | 400 = closed/draft
GET  /repos/{o}/{r}/pulls/123/merge-async/{uuid} → merged {sha} | enqueued | failed {message}   (kept 24 h; or wait for pull_request.closed)
fallback: PUT /repos/{o}/{r}/pulls/123/merge {"sha":"<graded head>","merge_method":"squash"} → 200 | 405 not mergeable | 409 "head did not match"
```
"Branch protection rules and repository rules are not run at this stage, only basic pull request state checks". A rule failure therefore arrives as `failed` on the GET [D:rest/pulls/pulls].

## 3. Merge queue (`merge_group`)

- Event: `merge_group`, availability **app only**, actions `checks_requested` and `destroyed`. "Status checks were requested for a merge group … When you receive this event, you should perform checks on the head SHA and report status back using check runs or commit statuses." `destroyed.reason` ∈ `merged|invalidated|dequeued` [D:webhooks/webhook-events-and-payloads#merge_group], [OAS]. Requires `merge_queues: read`.
- Payload `merge_group` = `{head_sha, head_ref, base_sha, base_ref, head_commit}`. `head_ref` is a temp branch "with the special prefix `gh-readonly-queue/{base_branch}`" [D:…/managing-a-merge-queue]. To find the PRs in a group, use GraphQL `repository{mergeQueue(branch:"main"){entries(first:100){nodes{pullRequest{number} headCommit{oid} baseCommit{oid} state position}}}}`, or walk `base_sha..head_sha` on the mirror.
- Respond with `POST /check-runs {name:"gittifacts/lane", head_sha: merge_group.head_sha, status:"in_progress"}`, then complete it. The name must equal the required check (with the same `integration_id` if pinned). Any App can be a required check. Actions is not special: "A merge queue may use GitHub Actions or your own CI provider". "A merge queue will wait for required checks to be reported before it can proceed".
- Timeouts and knobs (ruleset `merge_queue` params [OAS]): `check_response_timeout_minutes` ("checks that have not reported a conclusion will be assumed to have failed"), `grouping_strategy` `ALLGREEN|HEADGREEN`, `max_entries_to_build` (1–100), `min/max_entries_to_merge`, `min_entries_to_merge_wait_minutes`, `merge_method`.
- Enqueue options: `merge-async {merge_action:"merge_queue", sha}` (contents:write), or GraphQL `enqueuePullRequest{pullRequestId, expectedHeadOid, jump}` (permission undocumented). Either way the PR must already meet the rules. Bypass doesn't carry into the queue (§2), so a required queue means Lane 0 goes through Path B.

## 4. Webhooks

- Headers: `X-GitHub-Delivery` ("A globally unique identifier (GUID) to identify the event"), `X-GitHub-Event`, `X-GitHub-Hook-ID`, `X-GitHub-Hook-Installation-Target-Type`/`-ID`, and `X-Hub-Signature-256` ("HMAC hex digest of the request body … SHA-256") [D:webhooks/webhook-events-and-payloads#delivery-headers]. Payloads over 25 MB are **not delivered**. `sender` may be the `ghost` user.
- Verify the signature over the **raw** body, with the `sha256=` prefix and a constant-time compare ("Never use a plain `==` operator") [D:webhooks/using-webhooks/validating-webhook-deliveries]. With per-customer Apps, pick the secret by `X-GitHub-Hook-Installation-Target-ID` (the App id) **before** verifying.
```ts
const mac = await crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", enc.encode(secret),
  { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), rawBody);
const ok = timingSafeEqual(enc.encode("sha256=" + hex(mac)), enc.encode(req.headers.get("x-hub-signature-256") ?? ""));
```
- Idempotency: "If you request a redelivery, the `X-GitHub-Delivery` header will be the same as in the original delivery". Respond "with a 2XX response within 10 seconds" [D:webhooks/using-webhooks/best-practices-for-using-webhooks]. So: Worker verifies → enqueue → 202, and dedupe on the delivery GUID in a DO/D1 table.
- "GitHub does not automatically redeliver failed deliveries" [D:webhooks/using-webhooks/handling-failed-webhook-deliveries]. Reconcile with `GET /app/hook/deliveries` and `POST /app/hook/deliveries/{id}/attempts`, both JWT-authenticated. The window is "the past 3 days" in the body (the page intro says 7), so design for 3 [D:webhooks/testing-and-troubleshooting-webhooks/redelivering-webhooks].

| Event (actions we use) | Needs |
|---|---|
| `installation` (`created, deleted, new_permissions_accepted, suspend, unsuspend`), `installation_repositories` (`added, removed`) | always delivered ("All GitHub Apps receive this event by default") |
| `pull_request` (`opened, synchronize, edited, reopened, closed, ready_for_review, converted_to_draft, enqueued, dequeued, auto_merge_*`, new `stacked`) | pull_requests: read |
| `pull_request_review` (`submitted, dismissed, edited`) | pull_requests: read |
| `check_run` (`requested_action, rerequested` need **checks: write**; `completed` to read Actions results), `check_suite` (`requested, rerequested, completed`) | checks. "Apps with write-level access for the Checks permission are automatically subscribed" |
| `issues` (`labeled, unlabeled, edited, closed`) | issues: read |
| `push` (`main.advanced`; also `gh-readonly-queue/*`) | contents: read |
| `merge_group` (`checks_requested, destroyed`) | merge_queues: read |
| `deployment_status` · `workflow_run` (`completed`) · `status` | deployments · actions · statuses (read) |

`check_run.requested_action` carries `requested_action.identifier` and `sender`. Re-check the sender with `GET …/collaborators/{u}/permission` (≥ write, and not the PR author) before recording a tour approval.

## 5. Rate limits and tokens

| Limit | Value | Source |
|---|---|---|
| REST primary per installation | 5,000/h, "+50 requests per hour for each repository" over 20 repos, "+50 … for each user" over 20 org users, "cannot increase beyond 12,500". GHEC orgs: 15,000 | [D:rest/using-the-rest-api/rate-limits-for-the-rest-api#primary-rate-limit-for-github-app-installations] |
| GraphQL primary per installation | 5,000 points/h with the same scaling, cap 12,500. GHEC: 10,000. Cost ≈ Σ connection requests / 100, min 1. `first/last` ≤ 100, ≤ 500k nodes per call, **10 s timeout** (timeouts also cost extra points) | [D:graphql/overview/rate-limits-and-query-limits-for-the-graphql-api] |
| Secondary | ≤100 concurrent (REST+GraphQL), ≤900 REST points/min (GET=1, write=5), ≤2,000 GraphQL points/min (query=1, mutation=5), ≤90 s CPU per 60 s, **≤80 content-creating requests/min and ≤500/h** | same pages |
| Search | 30 req/min, ≤1,000 results per query | [D:rest/search/search#rate-limit] |
| Conditional requests | "does not count against your primary rate limit if a `304` response is returned and the request was made while correctly authorized" | [D:rest/using-the-rest-api/best-practices-for-using-the-rest-api#use-conditional-requests] |
| Backoff | 403/429 (GraphQL secondary: 200/403). Honor `retry-after`; if `x-ratelimit-remaining=0` wait until `x-ratelimit-reset`; "Otherwise, wait for at least one minute", then exponential, then give up. "make requests serially instead of concurrently" | [D:rest/using-the-rest-api/rate-limits-for-the-rest-api#exceeding-the-rate-limit] |

Tokens. `POST /app/installations/{id}/access_tokens` takes a JWT (RS256, `iat` = now−60 s, `exp` ≤ 10 min, `iss` = client ID). "The installation access token will expire after 1 hour." Body `repositories` or `repository_ids` (≤500): "The installation access token cannot be granted access to repositories that the installation was not granted access to". `permissions`: "cannot be granted permissions that the app was not granted" [D:apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app]. Since 2026-04-27, tokens are a stateless `ghs_…` JWT-like format, "~520 characters, two dots". Size storage columns for that [CL:2026-05-15-github-app-installation-tokens-per-request-override-header]. Revoke early with `DELETE /installation/token`. The rate-limit bucket is **per installation**, shared by every token we mint for it.

## 6. Fork PRs

- Detect with `pull_request.head.repo.full_name != base.repo.full_name` (also `head.repo.fork`). `maintainer_can_modify` is on the PR object. Check-run payloads for fork pushes have an "empty `pull_requests` array and a null value for `head_branch`" [D:webhooks/webhook-events-and-payloads#check_run], so map head_sha → PR ourselves.
- Read the code from the **base** repo, `git fetch origin pull/<n>/head` ("The remote `refs/pull/` namespace is *read-only*" [D:pull-requests/…/checking-out-pull-requests-locally]), using the base installation token with contents:read. That token can't reach the fork repo itself.
- Pushing: "you need push access to the base repository, permission from the pull request creator, and a user-owned fork" [D:pull-requests/how-tos/commit-changes/committing-changes-to-a-pull-request-branch-created-from-a-fork]. "You cannot give push permissions to a fork owned by an organization" [D:pull-requests/reference/forks]. Whether an App installation token can push is **undocumented**. `GITHUB_TOKEN` cannot [EMP:community#75867]. autofix.ci (a GitHub App) does push to fork PRs [EMP:autofix.ci]. Rule: `canPushToChangeBranch = sameRepo || (maintainer_can_modify && headOwner.type=="User" && verifiedOnTestOrg)`, and never with commits touching `.github/workflows` (needs `workflows`).
- Security: "Workflows that use these triggers must not explicitly check out untrusted code, including from pull request forks"; privileged triggers "share the same cache of the main branch … and may have repository write access" [D:actions/reference/security/secure-use#mitigating-the-risks-of-untrusted-code-checkout]. What this means for us: fork code only runs in sandboxes with no token and registry-only egress. Title, body and diff are untrusted prompt input. Write-scoped tokens are never minted on a code path that executed fork code.

## 7. App creation (manifest), install, least privilege

Flow [D:apps/sharing-github-apps/registering-a-github-app-from-a-manifest]:
1. Form-POST the field `manifest=<json>` to `https://github.com/settings/apps/new?state=…`, or to `…/organizations/ORG/settings/apps/new?state=…`.
2. GitHub redirects to `redirect_url?code=…&state=…`.
3. `POST /app-manifests/{code}/conversions` (no auth). "You must complete all three steps … within one hour."

The step-3 response is the App object plus `client_id`, `client_secret`, `webhook_secret`, `pem` [OAS]. GitHub generates the webhook secret, and the manifest has no `secret` field. Manifest keys: `name, url (required), hook_attributes{url, active}, redirect_url, callback_urls (≤10), setup_url, description, public, default_events, default_permissions, request_oauth_on_install, setup_on_update`.

Install: the user picks repos and is sent to `setup_url?installation_id=…`. "Bad actors can hit this URL with a spoofed `installation_id`… generate a user access token for the user who installed the GitHub App and then check that the installation is associated with that user" [D:apps/creating-github-apps/registering-a-github-app/about-the-setup-url]. A private App "can only be installed on the account that owns the app" [D:apps/creating-github-apps/registering-a-github-app/making-a-github-app-public-or-private]. Adding permissions later prompts each installation owner, and "If the account owner does not approve the new permissions, their installation will continue to use the old permissions" [D:apps/…/choosing-permissions-for-a-github-app]. That arrives as `installation.new_permissions_accepted`.

**Reader App (default; shadow mode).** Least privilege, exactly §3.1 minus writes we don't need:
```json
{ "name": "gittifacts", "url": "https://gittifacts.example",
  "hook_attributes": { "url": "https://hooks.gittifacts.example/github", "active": true },
  "redirect_url": "https://gittifacts.example/github/manifest/callback",
  "callback_urls": ["https://gittifacts.example/github/oauth/callback"],
  "setup_url": "https://gittifacts.example/github/setup", "setup_on_update": true, "request_oauth_on_install": true,
  "public": true,
  "default_permissions": { "metadata": "read", "contents": "read", "pull_requests": "write", "checks": "write", "issues": "read" },
  "default_events": ["pull_request", "pull_request_review", "check_run", "check_suite", "issues", "push"] }
```
**Actor App (opt-in; Lane 0 merge, enqueue, revert PRs, resolver).** Created by the customer via the same manifest flow with `"public": false` and `"name": "gittifacts-actor-<org>"`, and installed on **selected** repos only. This App is the bypass actor or approver. It never runs on fork-code paths, and it reads checks to confirm everything is green on the head before merging.
```json
{ "default_permissions": { "metadata": "read", "contents": "write", "pull_requests": "write", "checks": "read" },
  "default_events": ["pull_request", "pull_request_review"] }
```
Further opt-ins, each behind its own toggle, are added to the **Reader** App. The Reader owns `gittifacts/lane`, so it must be the App that receives `merge_group` and posts the merge-group check. The opt-ins: `merge_queues: read` (+`merge_group`), `actions: read` (+`workflow_run`), `deployments: read` (+`deployment_status`), `statuses: read` (+`status`). Not requested: `administration`, `workflows`.

## 8. Backtesting (90 days)

- List merged PRs with GraphQL `repository.pullRequests(states:MERGED, first:100, orderBy:{field:UPDATED_AT, direction:DESC})`. You can't order by merge date, so page until `updatedAt < windowStart` and filter on `mergedAt`. [LIVE] on vercel/next.js, 100 PRs with `files(first:100)`, the last commit and `closingIssuesReferences` cost **3 points**. 100 PRs covered about 16 days.
- Search alternative: `is:pr is:merged merged:>=YYYY-MM-DD`. [LIVE] it returned **1,404** for next.js over 90 days, which is over the 1,000-result cap, so slice by month. Search runs 30/min.
- Reverts, using the same pages (no extra cost): title `^Revert "`, body `Reverts (owner/repo)?#N`, head ref `revert-<N>-<branch>` (GitHub's Revert button; [LIVE] next.js #98715 → `revert-98095-…`), commit body `This reverts commit <sha>.` (git), and `Revert "Revert …"` for re-lands.
- "Fix PRs touching the same lines within 14 days": REST has **no blame endpoint**. GraphQL `Commit.blame(path)` → `ranges{startingLine endingLine commit{oid}}` cost 1 point and took ~1.4 s [LIVE]. Adding `associatedPullRequests` per range **timed out (>10 s)** [LIVE]. Do it on the Artifacts mirror instead (`git log -L`, `git blame -L <base of Q>`, 0 API points). Map commit → PR from the listing (`mergeCommit.oid`) or with batched aliases of `commit(oid){associatedPullRequests(first:1)}`.
- Budget for a busy repo (~1,400 PRs): about 15–25 list pages × 3, plus reviews and check suites at ≤25/page, comes to **≈ 50–500 GraphQL points**. That's ≤10% of a 5,000-point hour. The REST equivalent (files + reviews + check-runs per PR) is about 4,200 requests, roughly a full hour. API cost is not the constraint. Mirror fetch and evidence compute are, so cap N by the compute budget.

## 9. Where GitHub's current behavior contradicts 06-two-modes.md §3

1. §3.1 "workflows read (reading Actions results)": no such permission (§0.4). Use `checks` (already held) and optionally `actions: read`.
2. §3.1 "Escalated permissions are opt-in per repo": permissions are per installation, so use the actor App on selected repos (§7).
3. §3.1 list is incomplete for §3.6: `merge_queues: read`, `deployments: read`, `statuses: read`. `contents: write` is also required for `enablePullRequestAutoMerge`. `workflows: write` is needed for reverts or resolver commits touching workflows. **This matches stop-and-ask #2. Recommendation: approve the read-only ones, and refuse workflow-touching reverts (open the revert PR as "needs human" instead).**
4. §3.6 "merge via the API … or enable GitHub auto-merge … (e.g. the App as a bypass actor)": bypass and auto-merge don't combine, and neither do bypass and the merge queue. Bypass means a direct merge only; auto-merge or the queue means Path B (approval).
5. §3.6 merge API: prefer `merge-async` (GA 2026-10-01 [CL:2026-10-01-github-async-merge-api-generally-available]). The sync endpoint "does not support stacked pull requests or merging with a merge queue".
6. §3.8 "unless … via the documented ruleset path": the ruleset path (A) needs **no** App approval, and the approval path (B) needs **no** ruleset change. These are two distinct opt-ins.
7. §3.4 "One check run per PR": it's one per **head SHA**, plus one per merge-group SHA. Buttons show only on completed runs and live in the Checks tab.
8. §3.4 "single PR review … update everything in place": inline comments can't move to new lines, and submitted reviews can't be deleted. Make it one tour review per head: edit the old review's body and stops to "stale", minimize it, and post the new one.
9. §3.4 "neutral = Lane 1" is fine, but it passes a required check (§1.1). Never use `gittifacts/lane` as the only gate.
10. §3.6 merge queue: only on org repos (public, or private on GHEC). Elsewhere `hasHostMergeQueue=false`.

## Decisions this forces

1. **Two Apps.** The public Reader App is the shadow-mode default. A customer-owned private actor App, created from a manifest, holds `contents: write` and is the only bypass or approve principal. `canMerge = actorAppInstalledOnRepo && (pathA || pathB configured)`.
2. **The Lane 0 wizard detects and explains.** It reads `GET /rules/branches/{b}`, each ruleset's `current_user_can_bypass` with the actor's token, and `GET /branches/{b}` (classic `protected` and approval count), all with metadata or contents read. It then emits the Path A rulesets JSON, or the Path B checklist when a merge queue is required or rulesets are unavailable. It never asks to lower approvals or remove checks for humans.
3. **Merge.** Recompute the lane on the exact head, then `merge-async {sha, direct_merge, bypass_rules: pathA}`. Await `pull_request.closed` or poll the uuid. On 409/`failed` with head moved, re-grade. Fall back to sync `/merge` with `sha`. Path B: `APPROVE(commit_id=head)` → verify `reviewDecision` → `merge-async {merge_action:"default"}`.
4. **`HostCapabilities` for GitHub** gains `mergeMode: 'none'|'bypass-direct'|'approve'` and `hostQueueRequired`. Degradations surface in the verdict ("ready to merge, labelled").
5. **Checks.** `gittifacts/lane` goes on each PR head and each merge-group head. Conclusions: success → Lane 0 eligible, neutral → Lane 1, action_required → Lane 2. Actions: `approve_tour` "Approve tour" and `full_review` "Request full review" (labels ≤20 chars). The summary stays ≤60 KB, with overflow linked via `details_url`.
6. **Writes are budgeted per installation** (≤80/min, ≤500/h content creation). Create the check once and update it once, edit the sticky comment and review only on change, post ≤20 stops, and serialize writes per installation in the coordinator DO.
7. **Webhook pipeline.** Pick the secret by App id, HMAC over the raw body, enqueue, and return 202 in <10 s. Dedupe on `X-GitHub-Delivery` with a ≥7-day TTL. A cron reconciles failed deliveries via `/app/hook/deliveries`, inside the 3-day window.
8. **Tokens.** Mint per job with `repository_ids:[id]` and the minimal `permissions`. Never on fork-code paths, never to sandboxes, never logged. Store as an opaque ≥1 KB string. `DELETE /installation/token` when the job ends. A rate governor per installation follows the backoff rules in §5 and uses ETags for every poll.
9. **Fork PRs.** Read via `pull/<n>/head`. Push only under the rule in §6. A GitHub approval counts for the platform only from users with write (`authorCanPushToRepository` / permission API) who are not the author. An agent-authored PR is never approved by an agent principal.
10. **Backtest** uses the GraphQL listing plus the mirror for reverts and 14-day line overlap. No GraphQL blame fan-out.
11. **Pin `X-GitHub-Api-Version: 2026-03-10`.** The default without the header is 2022-11-28. The only break we touch: `GET /rate_limit` drops `rate` (read `resources.core`) [D:rest/about-the-rest-api/breaking-changes].

## Open questions (verify on the live test org before M5)

1. Does `merge-async {merge_action:"merge_queue", bypass_rules:true}` let a bypass actor **enter** the queue without approvals, without skipping it? (It went GA 2 days ago and is untested. A yes would make Path A work with merge queues.)
2. Does an App `APPROVE` count with `contents: write`, for rulesets and classic BP, with `require_last_push_approval` and `dismiss_stale_reviews_on_push`? (Only [EMP] so far.)
3. Can a checks-only App be chosen as the required-check source? The ruleset doc says "The app must be installed in the repository with the `statuses:write` permission".
4. What permission do `enqueuePullRequest` and `merge-async` `merge_queue` need (`merge_queues: write`?)
5. Can an installation token push to a user-owned fork PR with `maintainer_can_modify`?
6. Is `actor_id` for `Integration` bypass the App id? (Assumed yes.) Does `pull_request` bypass mode apply to `merge-async` direct merges?
7. Who can click check-run buttons (any reader?) We re-check the sender anyway.
8. github/docs#45265: if GitHub makes auto-merge honor bypass, Path A extends to auto-merge. Watch the changelog.
9. Are the content-creation secondary limits per installation or per App across installations? This matters for the public Reader App at scale.
