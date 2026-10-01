/**
 * M1 acceptance against a DEPLOYED platform (not run in CI): an agent clones its change's fork,
 * pushes a commit, and gets test results back through MCP.
 *
 *   pnpm tsx scripts/e2e/m1.ts --url https://gittifacts.<you>.workers.dev --token gtf_… \
 *     [--repo <repoId>] [--plan <planId>] [--timeout-min 30] [--keep]
 *
 * `--url`/`--token` may come from GITTIFACTS_URL / GITTIFACTS_TOKEN. The token is an agent token
 * (`POST /api/v1/principals/agents` as a human, or the web UI). Without `--repo` the first repo the
 * agent may start changes on is used; it needs at least one commit on its default branch.
 *
 * Steps: whoami → start_change → git clone the fork with the push grant → commit → git push →
 * wait_for_change(evidence_ready) → print the run's steps, the test evidence, the lane and the
 * test step's log tail. Exits 0 when CI passed and the evidence signature verified.
 *
 * The grant's token reaches git only through GIT_CONFIG_* environment variables (an
 * `http.extraHeader`), never argv or .git/config.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createPlatformClient, type PlatformClient } from "../../packages/mcp/src/client.js";

const { values: args } = parseArgs({
  options: {
    url: { type: "string" },
    token: { type: "string" },
    repo: { type: "string" },
    plan: { type: "string" },
    "timeout-min": { type: "string", default: "30" },
    keep: { type: "boolean", default: false },
  },
});

const BASE_URL = (args.url ?? process.env.GITTIFACTS_URL ?? "").replace(/\/+$/, "");
const TOKEN = args.token ?? process.env.GITTIFACTS_TOKEN ?? "";
const DEADLINE = Date.now() + Number(args["timeout-min"]) * 60_000;

function die(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

if (BASE_URL === "" || TOKEN === "")
  die("pass --url and --token (or GITTIFACTS_URL / GITTIFACTS_TOKEN)");

const t0 = Date.now();
const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const log = (message: string) => console.log(`[${elapsed().padStart(7)}] ${message}`);

interface Grant {
  url: string;
  username: string;
  token: string;
  expiresAt: string;
  branch: string;
}

/** Runs git with the grant as an Authorization header from the environment. */
function git(cwd: string, grant: Grant, gitArgs: string[]): string {
  const basic = Buffer.from(`${grant.username}:${grant.token}`).toString("base64");
  const res = spawnSync("git", gitArgs, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.extraHeader",
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
    },
  });
  if (res.status !== 0) {
    const out = `${res.stdout ?? ""}${res.stderr ?? ""}`.replaceAll(grant.token, "<token>");
    die(`git ${gitArgs.join(" ")} failed (${res.status}):\n${out}`);
  }
  return (res.stdout ?? "").trim();
}

/** The success branch of a typed MCP tool result (mcp-tada narrows `structuredContent` on `isError`). */
type Success<R> = R extends { isError: true }
  ? never
  : R extends { structuredContent: infer T }
    ? T
    : never;

/** structuredContent of a tool call, or exit with the tool's error (fix hint included). */
function ok<R extends { isError?: boolean; content: Array<{ type: string }> }>(
  name: string,
  r: R,
): Success<R> {
  if (r.isError === true) {
    const text = r.content
      .map((c) => ("text" in c && typeof c.text === "string" ? c.text : ""))
      .join("\n");
    die(`${name} failed: ${text}`);
  }
  return (r as unknown as { structuredContent: Success<R> }).structuredContent;
}

async function readLogTail(ref: string, lines = 15): Promise<string | null> {
  const res = await fetch(
    `${BASE_URL}/api/v1/blobs/${ref.split("/").map(encodeURIComponent).join("/")}`,
    {
      headers: { authorization: `Bearer ${TOKEN}` },
    },
  );
  if (!res.ok) return null;
  return (await res.text()).trimEnd().split("\n").slice(-lines).join("\n");
}

async function main(): Promise<void> {
  log(`platform ${BASE_URL}`);
  const mcp: PlatformClient = await createPlatformClient(`${BASE_URL}/mcp`, TOKEN, {
    clientName: "gittifacts-e2e-m1",
  });
  const workdir = mkdtempSync(join(tmpdir(), "gittifacts-m1-"));
  try {
    // ------------------------------------------------------------ who am I, which repo
    const me = ok("whoami", await mcp.tools.whoami());
    log(`agent ${me.name} (${me.principalId}), scopes: ${me.scopes.join(", ")}`);
    const repo =
      args.repo !== undefined
        ? me.repos.find((r) => r.id === args.repo)
        : me.repos.find((r) => r.actions.includes("start-change"));
    if (repo === undefined) {
      die(
        args.repo !== undefined
          ? `repo ${args.repo} is not one this agent can act on`
          : "this agent cannot start changes on any repo: create one first (POST /api/v1/repos)",
      );
    }
    log(`repo ${repo.name} (${repo.id}), ${repo.claim.status}`);

    // ------------------------------------------------------------ start_change
    const stamp = new Date().toISOString();
    const started = ok(
      "start_change",
      await mcp.tools.start_change({
        repoId: repo.id,
        title: `M1 e2e ${stamp}`,
        category: "chore",
        ...(args.plan !== undefined ? { planId: args.plan } : {}),
        idempotencyKey: `m1-e2e-${stamp}`,
      }),
    );
    const { change, remote } = started;
    log(
      `change ${change.id}: ${change.status}; fork remote ${remote.url} (branch ${remote.branch})`,
    );
    log(`push grant expires ${remote.expiresAt}`);

    // ------------------------------------------------------------ clone, commit, push
    const dir = join(workdir, "fork");
    git(workdir, remote, ["clone", "--quiet", "--branch", remote.branch, remote.url, dir]);
    const base = git(dir, remote, ["rev-parse", "HEAD"]);
    log(`cloned fork at ${base.slice(0, 12)}`);
    writeFileSync(
      join(dir, "E2E-M1.md"),
      `# M1 end-to-end\n\nPushed by scripts/e2e/m1.ts at ${stamp} for change ${change.id}.\n`,
    );
    git(dir, remote, ["add", "E2E-M1.md"]);
    git(dir, remote, [
      "-c",
      "user.name=gittifacts e2e",
      "-c",
      "user.email=e2e@gittifacts.dev",
      "commit",
      "--quiet",
      "-m",
      `M1 e2e: add E2E-M1.md (${stamp})`,
    ]);
    const head = git(dir, remote, ["rev-parse", "HEAD"]);
    git(dir, remote, ["push", "--quiet", "origin", `HEAD:refs/heads/${remote.branch}`]);
    log(`pushed ${head.slice(0, 12)} → ${remote.branch}`);

    // ------------------------------------------------------------ wait for evidence
    let reached = false;
    while (!reached && Date.now() < DEADLINE) {
      const timeoutSec = Math.max(1, Math.min(600, Math.floor((DEADLINE - Date.now()) / 1000)));
      const w = ok(
        "wait_for_change",
        await mcp.tools.wait_for_change({
          changeId: change.id,
          until: "evidence_ready",
          timeoutSec,
        }),
      );
      log(`wait_for_change(evidence_ready): ${w.reason}; status ${w.change.status}`);
      if (w.reason === "unreachable")
        die(`the change can no longer produce evidence (${w.change.status})`);
      reached = w.reached;
      if (!reached) {
        const s = ok(
          "get_change_status",
          await mcp.tools.get_change_status({ changeId: change.id }),
        );
        for (const r of s.runs)
          log(
            `  run ${r.id}: ${r.status} [${r.steps.map((st) => `${st.name}:${st.status}`).join(" ")}]`,
          );
      }
    }
    if (!reached) die(`no evidence within ${args["timeout-min"]} minutes`);

    // ------------------------------------------------------------ results
    const status = ok(
      "get_change_status",
      await mcp.tools.get_change_status({ changeId: change.id }),
    );
    const run = status.runs.find((r) => r.headSha === head) ?? status.runs[0];
    console.log("\n== CI run");
    if (run === undefined) console.log("  (no run recorded)");
    else {
      console.log(`  ${run.id}: ${run.status}`);
      for (const st of run.steps)
        console.log(`  - ${st.kind.padEnd(8)} ${st.name.padEnd(28)} ${st.status}`);
    }

    const evidence = ok("get_evidence", await mcp.tools.get_evidence({ changeId: change.id }));
    console.log(
      `\n== Evidence (${evidence.items.length} items, signature ${evidence.verification.ok ? "verified" : `NOT verified: ${evidence.verification.reason ?? "?"}`}, key ${evidence.keyId})`,
    );
    for (const item of evidence.items) {
      const i = item as {
        kind: string;
        status: string;
        note?: string;
        passed?: number;
        failed?: number;
        skipped?: number;
      };
      const counts =
        i.kind === "test-run"
          ? ` passed=${i.passed ?? "?"} failed=${i.failed ?? "?"} skipped=${i.skipped ?? "?"}`
          : "";
      console.log(`  - ${i.kind.padEnd(20)} ${i.status}${counts}${i.note ? ` (${i.note})` : ""}`);
    }

    const after = ok(
      "get_change_status",
      await mcp.tools.get_change_status({ changeId: change.id }),
    );
    const cls = after.classification;
    console.log(
      `\n== Lane: ${cls === null ? "not assigned yet" : `${cls.lane} (computed ${cls.computedLane}${cls.shadow ? ", shadow" : ""})`}`,
    );
    for (const r of cls?.reasons ?? [])
      if (r.lane > 0) console.log(`  - L${r.lane} ${r.code}: ${r.message}`);
    console.log(`  status: ${after.change.status}`);
    for (const n of after.nextSteps)
      console.log(`  next: ${n.title}${n.call ? ` → ${n.call}` : ""}`);

    const testStep = run?.steps.find((st) => st.name === "test" && st.logRef !== null);
    if (testStep?.logRef) {
      const tail = await readLogTail(testStep.logRef);
      console.log(`\n== ${testStep.logRef} (tail)\n${tail ?? "  (log not readable)"}`);
    }

    const passed = run?.status === "passed" && evidence.verification.ok;
    log(
      passed
        ? "✓ M1: test results came back through MCP"
        : "✗ M1: CI did not pass or the evidence did not verify",
    );
    process.exitCode = passed ? 0 : 1;
  } finally {
    await mcp.client.close();
    if (args.keep) log(`kept ${workdir}`);
    else rmSync(workdir, { recursive: true, force: true });
  }
}

await main().catch((e: unknown) => die(e instanceof Error ? (e.stack ?? e.message) : String(e)));
