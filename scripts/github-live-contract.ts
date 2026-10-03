/**
 * The host contract suite against GitHub, live: the test org's repo, the real Reader App, the
 * deployed platform. Nightly (.github/workflows/github-live.yml) and by hand. It skips cleanly
 * (exit 0, "skipped") until its configuration exists.
 *
 *   GITHUB_TEST_REPO        owner/repo in the test org (seeded from fixtures/_base, docs/github-mode)
 *   GITHUB_TEST_TOKEN       a token that may push branches and open PRs there (the PR *author*;
 *                           never the App's)
 *   GITTIFACTS_URL          the platform (default https://gittifacts.decroockjovi.workers.dev)
 *   GITTIFACTS_AGENT_TOKEN  an agent token of a human who linked the installation (reads results)
 *   GITTIFACTS_READ=d1      instead of the agent token: read verdicts and evidence straight from the
 *                           platform's D1 with wrangler (operators only; scenarios that need a Plan
 *                           report "needs-plan-approval", since creating one needs a human's agent)
 *   CONTRACT_SCENARIOS      optional comma list (default: every "grade" scenario)
 *
 * Per scenario: materialize the fixture, make the repo's main its base (a dedicated test repo),
 * push the head as a branch, open a PR (the claim in the title, the Plan in the body), wait for
 * the `gittifacts/lane` check run, read the verdict and evidence over MCP, compare with the same
 * expectations the recorded-fixture suite uses, record time-to-grade, close the PR. A lane or
 * evidence mismatch exits 1 (a §9 stop-and-ask: report it, don't paper over it).
 */
import { execFileSync } from "node:child_process";
import { CONTRACT_SCENARIO_NAMES, CONTRACT_SCENARIOS, type ContractScenario } from "../packages/host-contract/src/scenarios.js";
import { materializeFixture } from "./lib/fixtures.js";

const env = process.env;
const REPO = env.GITHUB_TEST_REPO ?? "";
const TOKEN = env.GITHUB_TEST_TOKEN ?? "";
const PLATFORM = (env.GITTIFACTS_URL ?? "https://gittifacts.decroockjovi.workers.dev").replace(/\/$/, "");
const AGENT = env.GITTIFACTS_AGENT_TOKEN ?? "";
const READ_D1 = env.GITTIFACTS_READ === "d1";
const API = "https://api.github.com";

if (!/^[\w.-]+\/[\w.-]+$/.test(REPO) || TOKEN === "" || (AGENT === "" && !READ_D1)) {
  console.log("skipped: set GITHUB_TEST_REPO, GITHUB_TEST_TOKEN and GITTIFACTS_AGENT_TOKEN (see the header)");
  process.exit(0);
}

async function gh<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2026-03-10",
      authorization: `Bearer ${TOKEN}`,
      "user-agent": "gittifacts-live-contract",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GitHub ${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
  return (text === "" ? null : JSON.parse(text)) as T;
}

let rpcId = 0;
/** One MCP tool call over streamable HTTP (stateless, JSON or SSE answer). */
async function mcp(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`${PLATFORM}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${AGENT}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
  });
  const text = await res.text();
  const json = text.startsWith("{") ? text : (text.split("\n").find((l) => l.startsWith("data: "))?.slice(6) ?? "{}");
  const out = JSON.parse(json) as { result?: { isError?: boolean; structuredContent?: Record<string, unknown>; content?: unknown } };
  if (out.result?.isError) throw new Error(`${name}: ${JSON.stringify(out.result.content).slice(0, 300)}`);
  return out.result?.structuredContent ?? {};
}

const git = (dir: string, args: string[]) =>
  execFileSync("git", ["-C", dir, "-c", `http.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString("base64")}`, ...args], { stdio: "pipe" }).toString();

const PREFIX: Record<string, string> = { fix: "fix", feature: "feat", refactor: "refactor", dependency: "deps", transform: "transform", revert: "revert", docs: "docs", chore: "chore" };

/** Plan ids per scenario, created once and approved once by a human (CONTRACT_PLANS, JSON). */
const PLANS: Record<string, string> = JSON.parse(env.CONTRACT_PLANS ?? "{}");

async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${PLATFORM}${path}`, {
    method,
    headers: { authorization: `Bearer ${AGENT}`, "content-type": "application/json", origin: PLATFORM },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`gittifacts ${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

/** The scenario's Plan on the GitHub repo: reused from CONTRACT_PLANS, else drafted for a human. */
async function planFor(s: ContractScenario, repoId: string): Promise<{ id: string; approved: boolean } | null> {
  if (s.plan === null) return null;
  const known = PLANS[s.name];
  if (READ_D1) {
    if (known === undefined) return { id: "(none: create and approve one on gittifacts)", approved: false };
    const [p] = d1<{ status: string }>(`select status from plans where id = '${known.replace(/[^\w-]/g, "")}'`);
    return { id: known, approved: p?.status === "approved" };
  }
  if (known !== undefined) {
    const { plan } = await api<{ plan: { status: string } }>("GET", `/api/v1/plans/${known}`);
    return { id: known, approved: plan.status === "approved" };
  }
  const created = await mcp("create_plan", {
    repoId, title: `[contract] ${s.name}`, intent: s.plan.intent, acceptanceCriteria: s.plan.acceptanceCriteria,
    outOfScope: s.plan.outOfScope, scopePaths: s.plan.scopePaths,
  });
  return { id: String((created.plan as { id: string }).id), approved: false };
}

/** One read-only D1 query on the deployed platform (GITTIFACTS_READ=d1). */
function d1<T>(sql: string): T[] {
  const out = execFileSync("pnpm", ["exec", "wrangler", "d1", "execute", "DB", "--remote", "--json", "--command", sql], {
    cwd: new URL("../apps/platform/", import.meta.url).pathname,
    env: { ...env, CI: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  }).toString();
  return (JSON.parse(out) as { results: T[] }[])[0]?.results ?? [];
}

type Verdict = { lane: number; computedLane: number; shadow: boolean; blocked: boolean; requiresHumanApproval: boolean; reasons: { code: string }[] };

/** The verdict and evidence kinds for a PR: over MCP (agent token) or from D1. */
async function readResult(ref: string, changeId: string, head: string): Promise<{ c: Verdict | undefined; kinds: string[] }> {
  if (!READ_D1) {
    const status = (await mcp("get_change_status", { github: ref })) as { classification?: Verdict };
    const evidence = (await mcp("get_evidence", { github: ref })) as { items?: { kind: string }[] };
    return { c: status.classification, kinds: [...new Set(evidence.items?.map((i) => i.kind) ?? [])].sort() };
  }
  if (!/^[\w-]+$/.test(changeId) || !/^[0-9a-f]{40}$/.test(head)) throw new Error("bad change id or head");
  const [row] = d1<{ lane: number; computed_lane: number; shadow: number; blocked: number; requires_human_approval: number; json: string }>(
    `select lane, computed_lane, shadow, blocked, requires_human_approval, json from classifications where change_id = '${changeId}' and head_sha = '${head}'`,
  );
  const [ev] = d1<{ json: string | null }>(`select json from evidence where change_id = '${changeId}' and head_sha = '${head}'`);
  const items = ev?.json ? ((JSON.parse(ev.json) as { items?: { kind: string }[] }).items ?? []) : [];
  const c: Verdict | undefined =
    row === undefined
      ? undefined
      : {
          lane: row.lane,
          computedLane: row.computed_lane,
          shadow: row.shadow === 1,
          blocked: row.blocked === 1,
          requiresHumanApproval: row.requires_human_approval === 1,
          reasons: (JSON.parse(row.json) as { reasons?: { code: string }[] }).reasons ?? [],
        };
  return { c, kinds: [...new Set(items.map((i) => i.kind))].sort() };
}

interface Result {
  scenario: string;
  status: "pass" | "mismatch" | "needs-plan-approval" | "error";
  detail: string[];
  timeToGradeSec: number | null;
}

async function runScenario(s: ContractScenario, runId: string, repoId: string): Promise<Result> {
  const out: Result = { scenario: s.name, status: "pass", detail: [], timeToGradeSec: null };
  const plan = await planFor(s, repoId);
  if (plan !== null && !plan.approved) {
    return { ...out, status: "needs-plan-approval", detail: [`approve plan ${plan.id} on gittifacts, then add {"${s.name}":"${plan.id}"} to CONTRACT_PLANS`] };
  }
  const fx = await materializeFixture(s.fixture);
  const remote = `https://github.com/${REPO}.git`;
  const branch = `contract/${s.name}-${runId}`;
  // The test repo's default branch becomes the fixture's base (policy and CI come from it).
  git(fx.dir, ["push", "-q", "--force", remote, `${fx.baseSha}:refs/heads/main`]);
  git(fx.dir, ["push", "-q", "--force", remote, `${fx.headSha}:refs/heads/${branch}`]);
  const pr = await gh<{ number: number; created_at: string }>("POST", `/repos/${REPO}/pulls`, {
    title: `${PREFIX[s.category] ?? "chore"}: ${fx.fixture.claim.title}`.slice(0, 200),
    head: branch,
    base: "main",
    body: `Live contract run ${runId}.${plan === null ? "" : `\n\ngittifacts-plan: ${plan.id}\n`}`,
  });
  try {
    const started = Date.parse(pr.created_at);
    let run: { status: string; conclusion: string | null; completed_at: string | null } | undefined;
    for (let i = 0; i < 120; i++) {
      const runs = await gh<{ check_runs: typeof run[] }>("GET", `/repos/${REPO}/commits/${fx.headSha}/check-runs?check_name=gittifacts/lane`);
      run = runs.check_runs.find((r) => r?.status === "completed");
      if (run) break;
      await new Promise((r) => setTimeout(r, 5000));
    }
    if (!run?.completed_at) return { ...out, status: "error", detail: ["no completed gittifacts/lane run within 10 minutes"] };
    out.timeToGradeSec = Math.round((Date.parse(run.completed_at) - started) / 1000);
    const ref = `${REPO}#${pr.number}`;
    const { c, kinds } = await readResult(ref, `gh-${repoId.replace(/^gh-/, "")}-${pr.number}`, fx.headSha);
    const e = s.expected;
    const want = { lane: e.lane, computedLane: e.computedLane, shadow: e.shadow, blocked: e.blocked, requiresHumanApproval: e.requiresHumanApproval };
    const got = c === undefined ? null : { lane: c.lane, computedLane: c.computedLane, shadow: c.shadow, blocked: c.blocked, requiresHumanApproval: c.requiresHumanApproval };
    if (JSON.stringify(got) !== JSON.stringify(want)) out.detail.push(`verdict ${JSON.stringify(got)} ≠ ${JSON.stringify(want)}`);
    const codes = new Set(c?.reasons.map((r) => r.code) ?? []);
    for (const code of e.includes) if (!codes.has(code)) out.detail.push(`missing reason ${code}`);
    for (const code of e.excludes) if (codes.has(code)) out.detail.push(`unexpected reason ${code}`);
    if (JSON.stringify(kinds) !== JSON.stringify(e.evidenceKinds)) out.detail.push(`evidence kinds ${kinds.join(",")} ≠ ${e.evidenceKinds.join(",")}`);
    if (out.detail.length > 0) out.status = "mismatch";
    return out;
  } finally {
    await gh("PATCH", `/repos/${REPO}/pulls/${pr.number}`, { state: "closed" }).catch(() => undefined);
    await gh("DELETE", `/repos/${REPO}/git/refs/heads/${branch}`).catch(() => undefined);
  }
}

const names = (env.CONTRACT_SCENARIOS?.split(",").map((n) => n.trim()) ?? CONTRACT_SCENARIO_NAMES.filter((n) => CONTRACT_SCENARIOS[n]().kind === "grade")) as (typeof CONTRACT_SCENARIO_NAMES)[number][];
const repo = await gh<{ id: number }>("GET", `/repos/${REPO}`);
const runId = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
const results: Result[] = [];
for (const name of names) {
  try {
    results.push(await runScenario(CONTRACT_SCENARIOS[name](), runId, `gh-${repo.id}`));
  } catch (e) {
    results.push({ scenario: name, status: "error", detail: [(e as Error).message], timeToGradeSec: null });
  }
  const r = results.at(-1);
  console.log(`${r?.status.padEnd(20)} ${name}${r?.timeToGradeSec == null ? "" : ` (graded in ${r.timeToGradeSec} s)`}${r?.detail.length ? `\n  ${r.detail.join("\n  ")}` : ""}`);
}
const times = results.flatMap((r) => (r.timeToGradeSec === null ? [] : [r.timeToGradeSec])).sort((a, b) => a - b);
console.log(`time-to-grade: n=${times.length} median=${times[Math.floor(times.length / 2)] ?? "-"} s max=${times.at(-1) ?? "-"} s`);
process.exit(results.some((r) => r.status === "mismatch" || r.status === "error") ? 1 : 0);
