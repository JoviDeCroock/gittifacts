/**
 * O5 acceptance against a DEPLOYED platform (not run in CI): a remote-only agent (no shell, no
 * git) does Plan → Change → workspace edit → test → push → evidence → tour over MCP alone.
 *
 *   pnpm tsx scripts/e2e/remote-workspace.ts --url https://gittifacts.<you>.workers.dev --token gtf_… \
 *     [--repo <repoId>] [--file <path>] [--test-command "pnpm test"] [--timeout-min 30] [--keep]
 *
 * `--url`/`--token` may come from GITTIFACTS_URL / GITTIFACTS_TOKEN (an agent token). Without
 * `--repo` the first repo the agent may start changes on is used. The edit appends a line to
 * `--file` (default README.md), so the Change is docs-only and stays small.
 * Exits 0 when the evidence verified and a tour exists for the pushed head.
 */
import { parseArgs } from "node:util";
import { createPlatformClient } from "../../packages/mcp/src/client.js";

const { values: args } = parseArgs({
  options: {
    url: { type: "string" },
    token: { type: "string" },
    repo: { type: "string" },
    file: { type: "string", default: "README.md" },
    "test-command": { type: "string", default: "pnpm test" },
    "timeout-min": { type: "string", default: "30" },
    keep: { type: "boolean", default: false },
  },
});

const BASE_URL = (args.url ?? process.env.GITTIFACTS_URL ?? "").replace(/\/+$/, "");
const TOKEN = args.token ?? process.env.GITTIFACTS_TOKEN ?? "";
const DEADLINE = Date.now() + Number(args["timeout-min"]) * 60_000;
const t0 = Date.now();
const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

function die(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}
if (BASE_URL === "" || TOKEN === "")
  die("pass --url and --token (or GITTIFACTS_URL / GITTIFACTS_TOKEN)");

type Res = { isError?: boolean; content?: unknown };
function ok<R extends Res>(
  what: string,
  r: R,
): R extends { structuredContent: infer S } ? S : never {
  if (r.isError) die(`${what}: ${JSON.stringify(r.content)}`);
  console.log(`✓ ${what} (${elapsed()})`);
  return (
    r as unknown as { structuredContent: R extends { structuredContent: infer S } ? S : never }
  ).structuredContent;
}

const mcp = await createPlatformClient(`${BASE_URL}/mcp`, TOKEN, {
  clientName: "e2e-remote-workspace",
});
let workspaceId: string | null = null;
try {
  const me = ok("whoami", await mcp.tools.whoami({}));
  const repoId = args.repo ?? me.repos.find((r) => r.actions.includes("start-change"))?.id;
  if (repoId === undefined) die("no repo this agent may start changes on; pass --repo");

  const { plan } = ok(
    "create_plan",
    await mcp.tools.create_plan({
      repoId,
      title: "Remote workspace e2e: note in the README",
      intent: "Prove a shell-less agent can edit, test and push through open_workspace alone.",
      acceptanceCriteria: [`${args.file} gains one line`],
      scopePaths: [args.file],
    }),
  );
  const { change } = ok(
    "start_change",
    await mcp.tools.start_change({
      repoId,
      planId: plan.id,
      title: "Remote workspace e2e",
      category: "docs",
    }),
  );

  let ws = ok("open_workspace", await mcp.tools.open_workspace({ changeId: change.id }));
  while (ws.status === "starting" && Date.now() < DEADLINE) {
    await new Promise((r) => setTimeout(r, 5000));
    ws = ok("open_workspace (again)", await mcp.tools.open_workspace({ changeId: change.id }));
  }
  workspaceId = ws.workspaceId;
  console.log(
    `  ${ws.workspaceId}: ${ws.status}, network ${ws.network}, from ${ws.restoredFrom}, expires ${ws.expiresAt}`,
  );

  const status = ok(
    "ws_exec git status",
    await mcp.tools.ws_exec({
      workspaceId,
      command: "git status --short --branch && git log --oneline -1",
    }),
  );
  console.log(status.stdout.trim().replace(/^/gm, "  "));
  const before = await mcp.tools.ws_read({ workspaceId, path: args.file });
  const content = before.isError ? "" : before.structuredContent.content;
  ok(
    "ws_write",
    await mcp.tools.ws_write({
      workspaceId,
      path: args.file,
      content: `${content}\nEdited remotely at ${new Date().toISOString()}.\n`,
    }),
  );
  const tests = ok(
    "ws_exec tests",
    await mcp.tools.ws_exec({ workspaceId, command: args["test-command"], timeoutSec: 300 }),
  );
  console.log(
    `  exit ${tests.exitCode}${tests.timedOut ? " (timed out)" : ""}; stdout tail:\n${tests.stdout.slice(-600).replace(/^/gm, "  ")}`,
  );
  const diff = ok("ws_diff", await mcp.tools.ws_diff({ workspaceId }));
  console.log(
    `  ${diff.files.map((f) => `${f.status} ${f.path} +${f.additions}/-${f.deletions}`).join(", ")}`,
  );

  const pushed = ok(
    "ws_commit_push",
    await mcp.tools.ws_commit_push({ workspaceId, message: "docs: remote workspace e2e" }),
  );
  console.log(`  pushed ${pushed.commitSha.slice(0, 12)} to ${pushed.branch}`);

  let reached = false;
  while (!reached && Date.now() < DEADLINE) {
    const w = ok(
      "wait_for_change evidence_ready",
      await mcp.tools.wait_for_change({
        changeId: change.id,
        until: "evidence_ready",
        timeoutSec: 50,
      }),
    );
    reached = w.reached;
    if (w.reason === "unreachable") die(`the change ended: ${w.change.status}`);
  }
  const evidence = ok("get_evidence", await mcp.tools.get_evidence({ changeId: change.id }));
  if (!evidence.verification.ok)
    die(`evidence signature does not verify: ${evidence.verification.reason}`);
  if (evidence.headSha !== pushed.commitSha)
    die(`evidence is for ${evidence.headSha}, pushed ${pushed.commitSha}`);

  reached = false;
  while (!reached && Date.now() < DEADLINE) {
    const w = ok(
      "wait_for_change tour_ready",
      await mcp.tools.wait_for_change({ changeId: change.id, until: "tour_ready", timeoutSec: 50 }),
    );
    reached = w.reached;
    if (w.reason === "unreachable") die(`the change ended: ${w.change.status}`);
  }
  const { tour } = ok("get_tour", await mcp.tools.get_tour({ changeId: change.id }));
  console.log(`  tour: ${tour.stops.length} stop(s) for ${tour.headSha.slice(0, 12)}`);
  console.log(`✓ remote-only loop complete in ${elapsed()}`);
} finally {
  if (workspaceId !== null && !args.keep)
    await mcp.tools.close_workspace({ workspaceId }).catch(() => undefined);
  await mcp.client.close();
}
