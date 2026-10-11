/**
 * Several agents attempt the same Plan, against a DEPLOYED platform (not run in CI). The live
 * counterpart of apps/platform/test/integration/attempts.test.ts and a demo for Cloudflare's "next
 * Git platform" brief: compare attempts at the same task, and let a person pick one with one tap.
 *
 * A human signs in and registers three agent principals (each its own token, owned by that human).
 * Agent 1 drafts a Plan scoped to `attempts/<stamp>/**`; the human approves the intent. Then all
 * three start a Change on that planId at once, with deliberately different quality:
 *   - minimal: one small file inside the Plan's scope;
 *   - drift:   the same file, plus an edit to README.md, outside the scope (scope drift → Lane 2);
 *   - red:     the same file, plus a test that fails (when the repo has a `test/` directory and
 *              vitest), else 400 lines of noise inside the scope (a bigger diff).
 * Each clones its fork, commits and pushes. The script waits until every attempt is graded, prints
 * compare_attempts' ranking, and the human picks the recommended one (POST …/attempts/:id/pick):
 * that approves it and closes the other two as superseded. The losers' wait_for_change says so;
 * the winner's wait_for_merge sees it land. Prints a summary, then revokes the agents' tokens.
 *
 *   GITTIFACTS_EMAIL=… GITTIFACTS_PASSWORD=… pnpm tsx scripts/e2e/attempts.ts \
 *     --url https://gittifacts.<you>.workers.dev --repo <repoId> [--timeout-min 45]
 *
 * or `--reviewer-cookie '<better-auth session cookie>'` instead of the email and password (never
 * pass a password on the command line). The human must be a maintainer (or above) on the repo to
 * approve the Plan. Exits 0 when the recommended attempt was the minimal one, the person's pick
 * closed the other two as superseded, and the winner merged.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createPlatformClient, type PlatformClient } from "../../packages/mcp/src/client.js";

const { values: args } = parseArgs({
  options: {
    url: { type: "string" },
    repo: { type: "string" },
    "reviewer-cookie": { type: "string" },
    "timeout-min": { type: "string", default: "45" },
    keep: { type: "boolean", default: false },
  },
});

const BASE_URL = (args.url ?? process.env.GITTIFACTS_URL ?? "").replace(/\/+$/, "");
const REPO_ID = args.repo ?? process.env.GITTIFACTS_REPO ?? "";
const DEADLINE = Date.now() + Number(args["timeout-min"]) * 60_000;
const t0 = Date.now();
const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const log = (who: string, message: string) =>
  console.log(`[${elapsed().padStart(7)}] ${who.padEnd(8)} ${message}`);

function die(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}
if (BASE_URL === "" || REPO_ID === "") die("pass --url and --repo (or GITTIFACTS_URL / _REPO)");

/** The human's session: a cookie, or an API sign-in with credentials from the environment only. */
async function humanCookie(): Promise<string> {
  const given = args["reviewer-cookie"] ?? process.env.GITTIFACTS_REVIEWER_COOKIE ?? "";
  if (given !== "") return given;
  const email = process.env.GITTIFACTS_EMAIL ?? "";
  const password = process.env.GITTIFACTS_PASSWORD ?? "";
  if (email === "" || password === "")
    die("pass --reviewer-cookie, or set GITTIFACTS_EMAIL and GITTIFACTS_PASSWORD");
  const res = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE_URL },
    body: JSON.stringify({ email, password }),
  });
  // Never echo the request or the response: say only what failed.
  if (!res.ok) die(`sign-in failed: HTTP ${res.status}`);
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0] ?? "")
    .find((c) => c.includes("session_token="));
  if (cookie === undefined) die("sign-in set no session cookie");
  return cookie;
}

/** A JSON call as the human (better-auth session cookie). */
async function asHuman<T>(
  cookie: string,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      cookie,
      origin: BASE_URL,
      ...headers,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, ok: res.ok, body: (text === "" ? null : JSON.parse(text)) as T };
}

interface Grant {
  url: string;
  token: string;
  branch: string;
}

/** git with the push grant as an Authorization header from the environment (never argv). */
function git(cwd: string, grant: Grant, gitArgs: string[]): string {
  const res = spawnSync("git", gitArgs, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.extraHeader",
      GIT_CONFIG_VALUE_0: `Authorization: Bearer ${grant.token}`,
    },
  });
  if (res.status !== 0) {
    const out = `${res.stdout ?? ""}${res.stderr ?? ""}`.replaceAll(grant.token, "<token>");
    throw new Error(`git ${gitArgs.join(" ")} failed (${res.status}):\n${out}`);
  }
  return (res.stdout ?? "").trim();
}

type Success<R> = R extends { isError: true }
  ? never
  : R extends { structuredContent: infer T }
    ? T
    : never;

function ok<R extends { isError?: boolean; content: Array<{ type: string }> }>(
  name: string,
  r: R,
): Success<R> {
  if (r.isError === true) {
    const text = r.content
      .map((c) => ("text" in c && typeof c.text === "string" ? c.text : ""))
      .join("\n");
    throw new Error(`${name} failed: ${text}`);
  }
  return (r as unknown as { structuredContent: Success<R> }).structuredContent;
}

type Quality = "minimal" | "drift" | "red";
const QUALITIES: readonly Quality[] = ["minimal", "drift", "red"];

interface Agent {
  label: string;
  quality: Quality;
  principalId: string;
  token: string;
  mcp: PlatformClient;
}

interface Attempt {
  agent: Agent;
  changeId: string;
  /** What the third agent did: a failing test, or noise when the repo has no vitest tests. */
  did: string;
}

/** Write the attempt's files into the clone; returns what it did, in words. */
function writeAttempt(dir: string, quality: Quality, stamp: string): string {
  const scope = join(dir, "attempts", stamp);
  mkdirSync(scope, { recursive: true });
  writeFileSync(
    join(scope, "NOTE.md"),
    `# Attempt ${stamp}\n\nWhat the plan asked for, and nothing else.\n`,
  );
  if (quality === "minimal") return "one small file, inside the plan's scope";
  if (quality === "drift") {
    const readme = join(dir, "README.md");
    const before = existsSync(readme) ? readFileSync(readme, "utf8") : "# README\n";
    writeFileSync(readme, `${before}\nAlso reworded while I was here (${stamp}).\n`);
    return "the same file, plus README.md (outside the plan's scope)";
  }
  const pkg = join(dir, "package.json");
  const vitest = existsSync(pkg) && readFileSync(pkg, "utf8").includes("vitest");
  if (vitest && existsSync(join(dir, "test"))) {
    writeFileSync(
      join(dir, "test", `attempt-${stamp}.test.ts`),
      `import { expect, it } from "vitest";\n\nit("attempt ${stamp} adds up", () => {\n  expect(1 + 1).toBe(3);\n});\n`,
    );
    return "the same file, plus a test that fails";
  }
  const noise = Array.from({ length: 400 }, (_, i) => `- generated line ${i + 1}`).join("\n");
  writeFileSync(join(scope, "NOISE.md"), `# Noise\n\n${noise}\n`);
  return "the same file, plus 400 lines of noise (the repo has no vitest tests to break)";
}

/** One agent: start a Change on the plan → clone its fork → commit → push. */
async function attempt(a: Agent, planId: string, workdir: string, stamp: string): Promise<Attempt> {
  const { change, remote, overlaps } = ok(
    `start_change ${a.label}`,
    await a.mcp.tools.start_change({
      repoId: REPO_ID,
      planId,
      title: `Attempt ${stamp} (${a.quality})`,
      category: "feature",
      paths: [`attempts/${stamp}/NOTE.md`],
      idempotencyKey: `attempts-${stamp}-${a.quality}`,
    }),
  );
  const others = overlaps?.overlaps.length ?? 0;
  log(
    a.label,
    `started ${change.id} on plan ${planId}${others > 0 ? ` (told: ${others} other attempt(s) on it)` : ""}`,
  );
  const dir = join(workdir, a.label);
  git(workdir, remote, ["clone", "--quiet", "--branch", remote.branch, remote.url, dir]);
  const did = writeAttempt(dir, a.quality, stamp);
  git(dir, remote, ["add", "-A"]);
  git(dir, remote, [
    "-c",
    `user.name=gittifacts ${a.label}`,
    "-c",
    "user.email=agents@gittifacts.dev",
    "commit",
    "--quiet",
    "-m",
    `${a.label}: attempt ${stamp}`,
  ]);
  git(dir, remote, ["push", "--quiet", "origin", `HEAD:refs/heads/${remote.branch}`]);
  log(a.label, `pushed: ${did}`);
  return { agent: a, changeId: change.id, did };
}

type Ranking = Success<Awaited<ReturnType<PlatformClient["tools"]["compare_attempts"]>>>;

/** compare_attempts until nothing is still grading (prints each change of the summary). */
async function untilGraded(a: Agent, planId: string): Promise<Ranking> {
  let last = "";
  for (;;) {
    const r = ok("compare_attempts", await a.mcp.tools.compare_attempts({ planId }));
    if (r.summary !== last) {
      last = r.summary;
      log("platform", last);
    }
    if (r.attempts.every((x) => x.standing !== "grading")) return r;
    if (Date.now() > DEADLINE) throw new Error(`timed out while grading: ${r.summary}`);
    // Each grading attempt's own long-poll paces the loop (no fixed sleeps).
    const grading = r.attempts.find((x) => x.standing === "grading");
    if (grading !== undefined)
      await a.mcp.tools.wait_for_change({
        changeId: grading.changeId,
        until: "tour_ready",
        timeoutSec: 30,
      });
  }
}

function printRanking(r: Ranking, attempts: Attempt[]): void {
  const who = (id: string) => attempts.find((x) => x.changeId === id)?.agent.label ?? id;
  console.log("\nrank  agent     lane  change                 why");
  for (const x of r.attempts)
    console.log(
      `${String(x.rank).padEnd(5)} ${who(x.changeId).padEnd(9)} ${String(x.lane ?? "-").padEnd(5)} ${x.changeId.padEnd(22)} ${x.recommended ? "★ " : "  "}${x.reasons.join(" · ")}`,
    );
  console.log(
    `\n${r.recommended === null ? "nothing recommended" : `recommended: ${who(r.recommended.changeId)} (${r.recommended.why})`}\n`,
  );
}

async function main(): Promise<void> {
  log("human", `platform ${BASE_URL}, repo ${REPO_ID}, 3 agents on one plan`);
  const cookie = await humanCookie();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const agents: Agent[] = [];
  const workdir = mkdtempSync(join(tmpdir(), "gittifacts-attempts-"));
  try {
    // ------------------------------------------------------------ three agents, one owner
    for (const quality of QUALITIES) {
      const label = `agent-${quality}`.slice(0, 13);
      const r = await asHuman<{ principal: { id: string }; token: string }>(
        cookie,
        "POST",
        "/api/v1/principals/agents",
        {
          name: `attempts ${quality} ${stamp}`,
          scopes: ["repo:read", "plan:create", "change:create"],
          expiresInDays: 1,
        },
      );
      if (!r.ok) throw new Error(`registering ${label}: HTTP ${r.status}`);
      const mcp = await createPlatformClient(`${BASE_URL}/mcp`, r.body.token, {
        clientName: `gittifacts-attempts-${quality}`,
      });
      agents.push({
        label: quality,
        quality,
        principalId: r.body.principal.id,
        token: r.body.token,
        mcp,
      });
      log(quality, `registered as ${r.body.principal.id}`);
    }
    const [minimal, drift] = agents as [Agent, Agent, Agent];

    // ------------------------------------------------------------ the intent, approved by a person
    const { plan, url: planUrl } = ok(
      "create_plan",
      await minimal.mcp.tools.create_plan({
        repoId: REPO_ID,
        title: `Attempts demo ${stamp}`,
        intent: "Add a short note under attempts/ explaining what this run is for.",
        acceptanceCriteria: [`attempts/${stamp}/NOTE.md exists and says what the run asked for`],
        scopePaths: [`attempts/${stamp}/**`],
        idempotencyKey: `attempts-${stamp}-plan`,
      }),
    );
    log(minimal.label, `drafted plan ${plan.id}: ${planUrl}`);
    const approved = await asHuman(cookie, "POST", `/api/v1/plans/${plan.id}/approve`, {});
    if (!approved.ok) throw new Error(`approving the plan: HTTP ${approved.status}`);
    log("human", "approved the plan's intent");

    // ------------------------------------------------------------ three attempts at once
    const attempts = await Promise.all(agents.map((a) => attempt(a, plan.id, workdir, stamp)));

    // ------------------------------------------------------------ graded, then ranked
    const ranking = await untilGraded(drift, plan.id);
    printRanking(ranking, attempts);
    const best = ranking.recommended;
    if (best === null || best.provisional) throw new Error("no finished attempt to recommend");
    const minimalId = attempts.find((x) => x.agent.quality === "minimal")!.changeId;
    if (best.changeId !== minimalId)
      throw new Error(
        `expected the minimal attempt (${minimalId}) to be recommended, got ${best.changeId}`,
      );

    // ------------------------------------------------------------ an agent can't pick
    const refused = await fetch(
      `${BASE_URL}/api/v1/plans/${plan.id}/attempts/${best.changeId}/pick`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${minimal.token}`, "content-type": "application/json" },
        body: "{}",
      },
    );
    const fix = ((await refused.json()) as { error?: { fix?: { call?: string } } }).error?.fix
      ?.call;
    log(
      minimal.label,
      `tried to pick its own attempt: HTTP ${refused.status} (fix: ${fix ?? "-"})`,
    );
    if (refused.status !== 403) throw new Error("an agent was allowed to pick");

    // ------------------------------------------------------------ one tap: the person picks
    const full = await asHuman<{
      attempts: Array<{ changeId: string; headSha: string | null }>;
    }>(cookie, "GET", `/api/v1/plans/${plan.id}/attempts`);
    const headSha =
      full.body.attempts.find((x) => x.changeId === best.changeId)?.headSha ?? undefined;
    const picked = await asHuman<{
      approved: boolean;
      superseded: Array<{ changeId: string; status: string }>;
      notClosed: Array<{ changeId: string; error: string }>;
    }>(
      cookie,
      "POST",
      `/api/v1/plans/${plan.id}/attempts/${best.changeId}/pick`,
      { headSha },
      {
        "idempotency-key": `attempts-${stamp}-pick`,
      },
    );
    if (!picked.ok) throw new Error(`pick: HTTP ${picked.status} ${JSON.stringify(picked.body)}`);
    log(
      "human",
      `picked ${best.changeId}: approved=${picked.body.approved}, closed ${picked.body.superseded.length} other attempt(s)`,
    );
    if (picked.body.notClosed.length > 0)
      throw new Error(`not closed: ${JSON.stringify(picked.body.notClosed)}`);

    // ------------------------------------------------------------ what each agent is told
    for (const x of attempts.filter((y) => y.changeId !== best.changeId)) {
      const w = ok(
        "wait_for_change",
        await x.agent.mcp.tools.wait_for_change({
          changeId: x.changeId,
          until: "merged",
          timeoutSec: 30,
        }),
      );
      log(
        x.agent.label,
        `wait_for_change: ${w.reason}${w.supersededBy ? ` by ${w.supersededBy}` : ""}`,
      );
      if (w.reason !== "superseded")
        throw new Error(`${x.agent.label} was not told it was superseded`);
    }
    const winner = attempts.find((x) => x.changeId === best.changeId)!;
    let merged = false;
    while (!merged && Date.now() < DEADLINE) {
      const m = ok(
        "wait_for_merge",
        await winner.agent.mcp.tools.wait_for_merge({ changeId: winner.changeId, timeoutSec: 30 }),
      );
      if (m.reason === "ejected" || m.reason === "dequeued")
        throw new Error(`the winner was ${m.reason}: ${m.status?.ejectReason?.message ?? ""}`);
      merged = m.reason === "merged";
      log(
        winner.agent.label,
        merged ? `merged as ${(m.status?.mergedSha ?? "").slice(0, 12)}` : `queue: ${m.reason}`,
      );
    }
    if (!merged) throw new Error("timed out before the winner merged");
    console.log(
      `\n✓ 3 attempts at one plan, ranked by evidence; a person picked the recommended one with one tap; ${picked.body.superseded.length} superseded; the winner merged, in ${elapsed()}`,
    );
  } finally {
    for (const a of agents) {
      await asHuman(cookie, "DELETE", `/api/v1/principals/${a.principalId}/tokens`).catch(() => {});
      await a.mcp.client.close().catch(() => {});
    }
    if (!args.keep) rmSync(workdir, { recursive: true, force: true });
  }
}

await main().catch((e: unknown) => die(e instanceof Error ? e.message : String(e)));
