/**
 * `AGENTS.md`, written into every repo at create/import time and regenerated through a Change when
 * `CONVENTIONS_VERSION` moves. Read by agents with no prior context, so it is short, imperative and
 * copy-pasteable. Hard limit: 150 lines (tested).
 */
import { call } from "./calls.js";
import { isTemplateId, TEMPLATES } from "./catalog.js";
import { cliCommand } from "./cli.js";
import { type Commands, commandsFor } from "./project.js";
import { CONVENTIONS_MARKER } from "./version.js";

export const AGENTS_MD_PATH = "AGENTS.md";
export const AGENTS_MD_MAX_LINES = 150;

export interface AgentsMdOptions {
  projectName: string;
  host: string;
  mcpUrl: string;
  repoId: string;
  claimed: boolean;
  /** Template id the project was created from; picks the command table. */
  template?: string | undefined;
  /** Command table for imported repos (from `commandsFor(detectProject(...).features)`). */
  commands?: Commands | undefined;
  /** Unclaimed projects: days after creation until the platform deletes it unless claimed. */
  unclaimedTtlDays?: number | undefined;
}

const DEFAULT_COMMANDS: Commands = {
  install: "pnpm install --frozen-lockfile",
  lint: "pnpm run lint",
  typecheck: "pnpm run typecheck",
  test: "pnpm run test",
  build: "pnpm run build",
  testFile: "pnpm exec vitest run",
  dev: null,
};

function commandsOf(opts: AgentsMdOptions): Commands {
  if (opts.commands !== undefined) return opts.commands;
  if (opts.template !== undefined && isTemplateId(opts.template))
    return commandsFor(TEMPLATES[opts.template].features);
  return DEFAULT_COMMANDS;
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export function agentsMd(opts: AgentsMdOptions): string {
  const host = trimSlash(opts.host);
  const repoId = opts.repoId;
  const cmd = commandsOf(opts);
  const testFile = cmd.testFile ?? cmd.test ?? "your test command";
  const ch = "<changeId>";
  const status = opts.claimed
    ? ["**claimed** (a human owns it). Auto-merge (Lane 0) stays off until the owner turns it on."]
    : [
        `**unclaimed**: deleted ${opts.unclaimedTtlDays === undefined ? "when it expires" : `${opts.unclaimedTtlDays} days after creation`} unless a human claims it.`,
        "  Give the `claimUrl` from `create_project` to a human (they log in to claim it).",
        "  Until then: previews only, no secrets, custom domains or production deploys, no Lane 0 or",
        "  auto-merge, registries-only egress, tight CI/storage/request quotas (`whoami` shows them).",
      ];

  const code = (c: string | null) => (c === null ? null : `\`${c}\``);
  const commandRows: [string, string | null][] = [
    ["install", code(cmd.install)],
    ["lint", code(cmd.lint)],
    ["typecheck", code(cmd.typecheck)],
    ["test (all)", code(cmd.test)],
    ["test (one file)", code(cmd.testFile === null ? null : `${cmd.testFile} test/<name>.test.ts`)],
    ["build", code(cmd.build)],
    [
      "local preview",
      cmd.dev === null
        ? null
        : `\`${cmd.dev}\` (wrangler isn't a dependency: install it globally or use \`npx wrangler dev\`)`,
    ],
  ];

  const lines = [
    CONVENTIONS_MARKER,
    `# AGENTS.md — ${opts.projectName}`,
    "",
    "This repo lives on **gittifacts**, an agent-native git platform. Humans approve intent (Plans),",
    "machines prove conformance (evidence), and every Change is routed to the cheapest safe review lane.",
    "",
    `- Repo: \`${repoId}\`${opts.template === undefined ? "" : ` (template \`${opts.template}\`)`}`,
    `- MCP: ${opts.mcpUrl}`,
    `- Guide: ${host}/start · API: ${host}/openapi.json`,
    "- CLI (every MCP tool as a shell command, JSON output; not on npm yet, the platform serves it):",
    `   \`${cliCommand(host, "--help")}\``,
    `- Status: ${status[0]}`,
    ...status.slice(1),
    "",
    "Every response has `nextSteps` and every error has `fix` (`call` / `command`). Do what they say.",
    "",
    "## The loop",
    "1. **Plan.** Describe the intent; a human approves it (you never can):",
    `   \`${call("create_plan", { repoId, title: "Add GET /version", intent: "Expose the deployed version so clients can check it.", acceptanceCriteria: ["GET /version returns { version }"], scopePaths: ["src/**", "test/**"] })}\``,
    "2. **Change.** Open one Change per intent. It returns `change.id` and a `remote` for **your fork only**:",
    `   \`${call("start_change", { repoId, planId: "<planId>", title: "Add GET /version", category: "feature" })}\``,
    "3. **Push** your commits to the fork:",
    '   `git -c http.extraHeader="Authorization: Bearer <remote.token>" push <remote.url> HEAD:<remote.branch>`',
    '4. **Wait** (long-poll ≤ 50 s, don\'t loop on status; call again while `reason` is `"timeout"`):',
    `   \`${call("wait_for_change", { changeId: ch, until: "evidence_ready", timeoutSec: 50 })}\``,
    `5. **Read** CI, lane, reasons and the preview URL: \`${call("get_change_status", { changeId: ch })}\``,
    `6. **Hand off** Lane 1/2 to a human: \`${call("request_review", { changeId: ch })}\`, then wait for \`merged\`.`,
    "",
    "No Plan yet? You may start a Change without `planId`; it can't auto-merge and scope can't be checked.",
    "Pushing again to the fork restarts the pipeline for the new head; the old run is superseded.",
    "",
    "## Hard rules",
    "- **Never push to main.** Only the merge queue writes the default branch. Push to your Change's fork.",
    "- **Agents never approve** a Plan or a Change, their own or anyone's. Ask with `request_review`.",
    "- One Change, one intent. Stay inside the Plan's `scopePaths`; other files are scope drift (higher lane).",
    "- Don't touch `.platform/**` unless the Plan says so: it always gets a full review (Lane 2) by a human.",
    "- Never commit secrets or tokens. Unclaimed repos have no secrets at all.",
    "- Retrying a create/mutate call? Send the same `Idempotency-Key`; a new request gets a new key.",
    "",
    "## Fixes need red/green proof",
    'A Change with `category: "fix"` must add or change a test that **fails on the base commit and passes',
    "on your head**. The platform re-runs exactly the new/changed test files on base and on head and signs",
    "the result. A fix without that proof gets a full review (Lane 2) and can never auto-merge.",
    "1. Write the test first, under `test/`, reproducing the bug.",
    `2. Run it before fixing: \`${testFile} test/<name>.test.ts\` must **fail** (red).`,
    "3. Fix the code and run it again: it must **pass** (green). Push test + fix in the same Change.",
    "If the platform reports the test passes on base, it doesn't reproduce the bug: tighten it.",
    "",
    "## Lanes",
    "| Lane | Name | What happens |",
    "|---|---|---|",
    "| 0 | Auto-merge | Merges through the merge queue with no review. **Off while the repo is calibrating** (every repo starts there) and for unclaimed repos: handled like a quick review. |",
    "| 1 | Quick review | A human reads the walkthrough and approves, often on a phone. |",
    "| 2 | Full review | A human reads the diff, with the walkthrough as a guide, before approving. |",
    "",
    "The lane is the maximum over its reasons; your category is an input, never the decision.",
    "Any one of these raises it:",
    "- No approved Plan → no auto-merge. Scope drift outside the Plan's `scopePaths` → raised.",
    "- Fix without red/green proof, breaking public API, new or major-bumped dependency → Lane 2.",
    "- Sensitive paths (auth, payments, migrations, `.platform/**`, wrangler config) → Lane 2.",
    "- Additive public API, low changed-line coverage or mutation score, large diff → Lane 1 (very large → 2).",
    "- A missing, skipped or errored measurement → raised. Unknown never lowers a lane.",
    "",
    "Stay low: small Changes, a test for every changed line, no new dependencies, stay in scope.",
    "",
    "## Reading a walkthrough",
    "For Lane ≥ 1 a separate reviewer agent writes a walkthrough from the Plan, the diff and the evidence (never",
    `from your own summary): \`${call("get_tour", { changeId: ch })}\`.`,
    "- Stops go intent → behaviour → riskiest hunk → its proof → what isn't covered.",
    "- Each stop has a verdict: `proven` (backed by evidence), `unproven` (a claim with no evidence), `risk`.",
    "- `leastConfident` and `notDone` list what the reviewer doubts or didn't check.",
    "To improve it, turn `unproven` stops into `proven` ones (add tests or evidence) and push again; the",
    `walkthrough is regenerated for the new head. Evidence details: \`${call("get_evidence", { changeId: ch })}\`.`,
    "",
    "## Waiting for results",
    `\`${call("wait_for_change", { changeId: ch, until: "<until>", timeoutSec: 50 })}\` long-polls; it returns`,
    "`{ change, reached, reason }` within 50 s (the MCP client's request timeout is 60 s).",
    "| `until` | Returns when |",
    "|---|---|",
    "| `evidence_ready` | CI finished (green or red) and the evidence is signed |",
    "| `lane_assigned` | the classifier has routed the Change |",
    "| `tour_ready` | the reviewer's walkthrough exists (Lane ≥ 1) |",
    "| `merged` | the merge queue fast-forwarded main |",
    "| `reverted` | the Change was rolled back and a revert Change was opened |",
    '`reason: "timeout"` → call it again with the same arguments until `reached` is true.',
    '`reason: "unreachable"` → the Change ended; read `get_change_status`.',
    "",
    "## After merge: rollout and the kill switch",
    "With a deploy target, a merged Change rolls out in stages (`rollout` in `.platform/policy.ts`) and is",
    "watched. Its flag `change-<changeId>` is on meanwhile; a regression switches it off, rolls the Worker",
    "back and opens a revert Change, with no human involved. Guard a risky new path with the flag so that",
    'switching it off restores the old one: `if (await isChangeEnabled(env, "<changeId>"))` (`src/flags.ts`',
    "in Workers templates). `env.FLAGS` exists only in deployed versions; elsewhere the Change counts as on.",
    "",
    "## When CI fails",
    `1. \`${call("get_change_status", { changeId: ch })}\` shows the failing step and its log tail.`,
    "2. Reproduce it locally with the same command (table below), fix it, commit, push again.",
    `3. Flaky, nothing to fix: \`${call("rerun_ci", { changeId: ch })}\` runs the same head again.`,
    `   A Change that won't merge: \`${call("close_change", { changeId: ch, reason: "<why>" })}\`.`,
    "",
    "## Commands",
    "| Step | Command |",
    "|---|---|",
    ...commandRows
      .filter((r): r is [string, string] => r[1] !== null)
      .map(([step, c]) => `| ${step} | ${c} |`),
    "",
    "## Files the platform owns",
    "- `.platform/ci.ts` (pipeline) and `.platform/policy.ts` (lanes, thresholds, sensitive paths) are read",
    "  from the base branch, never from your head. Editing either is Lane 2.",
    "- `AGENTS.md` (this file) is regenerated by the platform through a Change when conventions change.",
    "",
  ];
  return lines.join("\n");
}
