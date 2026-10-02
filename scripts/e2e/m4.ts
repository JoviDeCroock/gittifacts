/**
 * M4 acceptance against a DEPLOYED platform (not run in CI): a Change that throws for ~40% of
 * traffic is deployed, and the platform detects it, switches its flag off, rolls the Worker back
 * and opens a (verified pure) revert Change with no human involved after the review.
 *
 *   pnpm tsx scripts/e2e/m4.ts --url https://gittifacts.<you>.workers.dev \
 *     --agent-file agent.json --cookie-jar cookies.txt [--project <repoId>] [--rps 5] \
 *     [--timeout-min 60] [--keep]
 *
 * Credentials: an agent token (`--agent-file` JSON `{ token }` or GITTIFACTS_TOKEN) and a human
 * session (`--cookie-jar`, a Netscape cookie file from `curl -c`). Neither is ever printed.
 *
 * Steps (human = the cookie, agent = the token; the human only creates, configures and reviews):
 *  1. human creates a `workers-api` project; the bootstrap Change goes green;
 *  2. agent proposes a faster rollout policy (`.platform/policy.ts`, Lane 2) → human approves →
 *     the merge queue merges it (policy is read from BASE, so this is how the e2e gets short stages);
 *  3. human sets the deploy target (`PATCH /repos/{id}/deploy-target`);
 *  4. agent adds `GET /version` → human approves → merge → first production deploy (100%);
 *  5. agent makes `/` throw for ~40% of requests when its flag is on → human approves → merge →
 *     gradual rollout; a traffic generator hits the workers.dev URL throughout;
 *  6. the platform detects the regression, switches the flag off, rolls back and opens the revert
 *     Change (deploy trains or the RolloutWorkflow, whichever the platform uses);
 *  7. the script checks the revert is a verified pure revert, the audit chain verifies, prints the
 *     timeline with latencies, and deletes the Worker unless `--keep`.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createPlatformClient, type PlatformClient } from "../../packages/mcp/src/client.js";

const { values: args } = parseArgs({
  options: {
    url: { type: "string" },
    "agent-file": { type: "string" },
    "cookie-jar": { type: "string" },
    project: { type: "string" },
    "workers-subdomain": { type: "string" },
    rps: { type: "string", default: "5" },
    "timeout-min": { type: "string", default: "75" },
    keep: { type: "boolean", default: false },
  },
});

const BASE_URL = (args.url ?? process.env.GITTIFACTS_URL ?? "").replace(/\/+$/, "");
const TOKEN =
  args["agent-file"] !== undefined
    ? String((JSON.parse(readFileSync(args["agent-file"], "utf8")) as { token?: unknown }).token)
    : (process.env.GITTIFACTS_TOKEN ?? "");
const COOKIE = args["cookie-jar"] !== undefined ? cookieHeader(args["cookie-jar"]) : "";
const DEADLINE = Date.now() + Number(args["timeout-min"]) * 60_000;
const RPS = Math.max(1, Math.min(20, Number(args.rps)));

const t0 = Date.now();
const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const log = (message: string) => console.log(`[${elapsed().padStart(7)}] ${message}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function die(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

if (BASE_URL === "" || TOKEN === "" || COOKIE === "")
  die("pass --url, --agent-file (or GITTIFACTS_TOKEN) and --cookie-jar");

/** `Cookie:` value from a Netscape cookie file (curl -c), for the platform host only. */
function cookieHeader(path: string): string {
  const host = new URL(BASE_URL).hostname;
  const pairs: string[] = [];
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.startsWith("#HttpOnly_") ? raw.slice("#HttpOnly_".length) : raw;
    if (line.startsWith("#") || line.trim() === "") continue;
    const f = line.split("\t");
    if (f.length < 7) continue;
    const domain = (f[0] ?? "").replace(/^\./, "");
    if (host === domain || host.endsWith(`.${domain}`)) pairs.push(`${f[5]}=${f[6]}`);
  }
  return pairs.join("; ");
}

// ---------------------------------------------------------------- HTTP (human session / agent)

async function api<T>(
  method: string,
  path: string,
  opts: { as?: "human" | "agent"; body?: unknown; key?: string } = {},
): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if ((opts.as ?? "human") === "human") headers.cookie = COOKIE;
  else headers.authorization = `Bearer ${TOKEN}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.key !== undefined) headers["idempotency-key"] = opts.key;
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 600)}`);
  return (text === "" ? null : JSON.parse(text)) as T;
}

interface ChangeView {
  id: string;
  status: string;
  headSha: string | null;
  mergedSha: string | null;
  lane: number | null;
  laneReasons: Array<{ code: string; lane: number; message: string }>;
  revertOf: string | null;
  revertedBy: string | null;
  flagKey: string | null;
  rolloutState: {
    status: string;
    versionId: string | null;
    previousVersionId: string | null;
    stages: Array<{ percent: number; startedAt: string | null }>;
  } | null;
}

const getChange = async (id: string) =>
  (await api<{ change: ChangeView }>("GET", `/api/v1/changes/${id}`)).change;

/** Poll the change (human view) until `done` says so; logs status transitions. */
async function until(
  id: string,
  what: string,
  done: (c: ChangeView) => boolean,
  fail: (c: ChangeView) => string | null = () => null,
  everyMs = 5000,
): Promise<ChangeView> {
  let last = "";
  for (;;) {
    const c = await getChange(id);
    const s = `${c.status}${c.rolloutState ? ` / rollout ${c.rolloutState.status}` : ""}`;
    if (s !== last) log(`  ${id}: ${s}`);
    last = s;
    if (done(c)) return c;
    const bad = fail(c);
    if (bad !== null) die(`${id}: ${bad}`);
    if (Date.now() > DEADLINE) die(`${id}: timed out waiting for ${what} (${s})`);
    await sleep(everyMs);
  }
}

// ---------------------------------------------------------------- agent: MCP + git

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
    die(`${name} failed: ${text}`);
  }
  return (r as unknown as { structuredContent: Success<R> }).structuredContent;
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
    die(`git ${gitArgs.join(" ")} failed (${res.status}):\n${out}`);
  }
  return (res.stdout ?? "").trim();
}

let mcp: PlatformClient;
let workdir = "";

/**
 * The agent's loop for one Change: start_change → clone the fork → edit → commit → push →
 * wait until the lane is assigned → request_review. Returns the Change id and the pushed head.
 */
async function agentChange(input: {
  repoId: string;
  title: string;
  category: "feature" | "chore" | "fix";
  edit: (dir: string, changeId: string) => void;
}): Promise<{ id: string; head: string }> {
  const stamp = new Date().toISOString();
  const { change, remote } = ok(
    "start_change",
    await mcp.tools.start_change({
      repoId: input.repoId,
      title: input.title,
      category: input.category,
      idempotencyKey: `m4-${input.repoId}-${input.title}-${stamp}`,
    }),
  );
  const dir = join(workdir, change.id);
  git(workdir, remote, ["clone", "--quiet", "--branch", remote.branch, remote.url, dir]);
  input.edit(dir, change.id);
  git(dir, remote, ["add", "-A"]);
  git(dir, remote, [
    "-c",
    "user.name=gittifacts m4 agent",
    "-c",
    "user.email=m4@gittifacts.dev",
    "commit",
    "--quiet",
    "-m",
    input.title,
  ]);
  const head = git(dir, remote, ["rev-parse", "HEAD"]);
  git(dir, remote, ["push", "--quiet", "origin", `HEAD:refs/heads/${remote.branch}`]);
  log(`agent pushed ${head.slice(0, 12)} for ${change.id} "${input.title}"`);
  for (;;) {
    const w = ok(
      "wait_for_change",
      await mcp.tools.wait_for_change(
        { changeId: change.id, until: "lane_assigned", timeoutSec: 50 },
        { timeout: 80_000 },
      ),
    );
    if (w.reached) break;
    if (w.reason === "unreachable") die(`${change.id} ended before a lane: ${w.change.status}`);
    if (Date.now() > DEADLINE) die(`${change.id}: no lane in time`);
  }
  const s = ok("get_change_status", await mcp.tools.get_change_status({ changeId: change.id }));
  log(
    `  ${change.id}: lane ${s.classification?.lane ?? "?"} (${(s.classification?.reasons ?? [])
      .filter((r) => r.lane > 0)
      .map((r) => r.code)
      .join(", ")})`,
  );
  ok("request_review", await mcp.tools.request_review({ changeId: change.id }));
  return { id: change.id, head };
}

/** The human approves the pushed head once the Change waits for review, then it merges. */
async function humanApproveAndMerge(id: string, head: string): Promise<ChangeView> {
  await until(
    id,
    "awaiting-review",
    (c) => c.status === "awaiting-review",
    (c) => (["failing", "rejected", "abandoned"].includes(c.status) ? `is ${c.status}` : null),
  );
  await api("POST", `/api/v1/changes/${id}/review`, {
    body: { decision: "approve", headSha: head, comment: "m4 e2e: approved by the human" },
    key: `m4-approve-${id}-${head}`,
  });
  log(`human approved ${id} at ${head.slice(0, 12)}`);
  return until(
    id,
    "merged",
    (c) => c.mergedSha !== null,
    (c) => (["failing", "rejected", "abandoned"].includes(c.status) ? `is ${c.status}` : null),
  );
}

function replaceIn(path: string, from: RegExp | string, to: string): void {
  const text = readFileSync(path, "utf8");
  const next = text.replace(from, to);
  if (next === text) die(`could not edit ${path}: pattern not found`);
  writeFileSync(path, next);
}

// ---------------------------------------------------------------- traffic generator

interface Hit {
  at: number;
  status: number;
}

class Traffic {
  readonly hits: Hit[] = [];
  readonly versions: Array<{ at: number; version: string | null }> = [];
  private n = 0;
  private running = false;
  private loops: Promise<void>[] = [];

  constructor(private readonly url: string) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loops.push(this.loop(), this.versionLoop());
  }

  async stop(): Promise<void> {
    this.running = false;
    await Promise.all(this.loops);
  }

  private async loop(): Promise<void> {
    const gap = 1000 / RPS;
    while (this.running) {
      const started = Date.now();
      const n = this.n++;
      void fetch(`${this.url}/?n=${n}`, { headers: { "cache-control": "no-store" } })
        .then(async (r) => {
          await r.arrayBuffer();
          this.hits.push({ at: started, status: r.status });
        })
        .catch(() => this.hits.push({ at: started, status: -1 }));
      await sleep(Math.max(0, gap - (Date.now() - started)));
    }
  }

  private async versionLoop(): Promise<void> {
    while (this.running) {
      try {
        const r = await fetch(`${this.url}/version`, { headers: { "cache-control": "no-store" } });
        const body = r.ok ? ((await r.json()) as { version?: string | null }) : null;
        this.versions.push({ at: Date.now(), version: body?.version ?? `http ${r.status}` });
      } catch {
        this.versions.push({ at: Date.now(), version: "unreachable" });
      }
      await sleep(5000);
    }
  }

  errorsBetween(from: number, to = Date.now()): { total: number; errors: number } {
    const window = this.hits.filter((h) => h.at >= from && h.at < to);
    return { total: window.length, errors: window.filter((h) => h.status >= 500).length };
  }

  firstError(after: number): number | null {
    return (
      this.hits.filter((h) => h.at >= after && h.status >= 500).sort((a, b) => a.at - b.at)[0]
        ?.at ?? null
    );
  }

  lastError(): number | null {
    return this.hits.filter((h) => h.status >= 500).sort((a, b) => b.at - a.at)[0]?.at ?? null;
  }
}

// ---------------------------------------------------------------- the throwing Change

/** `/` throws for 2 in 5 requests that carry `?n=` (real traffic), only while the flag is on. */
function makeRootThrow(dir: string, changeId: string): void {
  const app = join(dir, "src/app.ts");
  replaceIn(
    app,
    'import type { Env } from "./index.js";',
    'import { isChangeEnabled } from "./flags.js";\nimport type { Env } from "./index.js";',
  );
  replaceIn(
    app,
    '"/": () => json({ now: new Date().toISOString() }),',
    `"/": async (_request, url, env) => {
    // M4: a regression that only shows up for real traffic, behind this Change's kill switch.
    if (url.searchParams.has("n") && (await isChangeEnabled(env, "${changeId}"))) {
      const n = Number(url.searchParams.get("n"));
      if (Number.isFinite(n) && n % 5 < 2) throw new Error(\`m4 regression for n=\${n}\`);
    }
    return json({ now: new Date().toISOString() });
  },`,
  );
}

/** `GET /version` → the deployed version (VERSION binding), with a test. */
function addVersionRoute(dir: string): void {
  replaceIn(
    join(dir, "src/app.ts"),
    '"/health": () => json({ ok: true }),',
    `"/health": () => json({ ok: true }),
  "/version": (_request, _url, env) =>
    json({ version: env.VERSION?.id ?? null, tag: env.VERSION?.tag ?? null }),`,
  );
  writeFileSync(
    join(dir, "test/version.test.ts"),
    `import { describe, expect, it } from "vitest";
import { handle } from "../src/app.js";

describe("GET /version", () => {
  it("returns the deployed version, or null outside a deployment", async () => {
    const local = await handle(new Request("https://example.test/version"));
    expect(await local.json()).toEqual({ version: null, tag: null });
    const env = { VERSION: { id: "v-1", tag: "c1", timestamp: "2026-10-02T00:00:00Z" } };
    const deployed = await handle(new Request("https://example.test/version"), env);
    expect(await deployed.json()).toEqual({ version: "v-1", tag: "c1" });
  });
});
`,
  );
}

const FAST_ROLLOUT = `rollout: {
    stages: [50, 100],
    stageMinutes: 2,
    watchMinutes: 3,
    maxErrorRateIncrease: 0.05,
    maxNewIssueGroups: 0,
    minRequests: 20,
  },`;

// ---------------------------------------------------------------- main

interface AuditRow {
  seq: number;
  at: string;
  principalId: string;
  action: string;
  subject: string;
  summary: string;
}

async function auditOf(subject: string): Promise<{ events: AuditRow[]; verified: boolean }> {
  const page = await api<{ events: AuditRow[]; chain: { verified: boolean } }>(
    "GET",
    `/api/v1/audit?subject=${encodeURIComponent(subject)}&limit=200`,
  );
  return { events: page.events, verified: page.chain.verified };
}

const marks: Record<string, number> = {};
const mark = (name: string, at = Date.now()) => {
  marks[name] ??= at;
};

async function main(): Promise<void> {
  log(`platform ${BASE_URL}`);
  mcp = await createPlatformClient(`${BASE_URL}/mcp`, TOKEN, { clientName: "gittifacts-e2e-m4" });
  workdir = mkdtempSync(join(tmpdir(), "gittifacts-m4-"));
  const me = ok("whoami", await mcp.tools.whoami());
  log(`agent ${me.name} (${me.principalId})`);
  let traffic: Traffic | null = null;
  let script: string | null = null;
  try {
    // ------------------------------------------------------------ 1. project
    let repoId = args.project ?? "";
    if (repoId === "") {
      const stamp = new Date()
        .toISOString()
        .replace(/[-:T.Z]/g, "")
        .slice(0, 14);
      const p = await api<{ projectId: string; name: string; bootstrapChangeId: string | null }>(
        "POST",
        "/api/v1/projects",
        { body: { name: `m4-${stamp}`, template: "workers-api" }, key: `m4-project-${stamp}` },
      );
      repoId = p.projectId;
      log(`human created project ${p.name} (${repoId})`);
      if (p.bootstrapChangeId !== null)
        await until(
          p.bootstrapChangeId,
          "bootstrap",
          (c) => c.status === "released",
          (c) => (c.status === "failing" ? "bootstrap CI failed" : null),
        );
      mark("bootstrapped");
    }

    // ------------------------------------------------------------ 2. faster rollout policy
    const policyChange = await agentChange({
      repoId,
      title: "Rollout policy: 50% → 100%, 2-minute stages, 3-minute watch",
      category: "chore",
      edit: (dir) =>
        replaceIn(join(dir, ".platform/policy.ts"), /rollout: \{[^}]*\},/, FAST_ROLLOUT),
    });
    await humanApproveAndMerge(policyChange.id, policyChange.head);
    mark("policy-merged");

    // ------------------------------------------------------------ 3. deploy target
    const target = await api<{ script: string }>("PATCH", `/api/v1/repos/${repoId}/deploy-target`, {
      body: { script: "api" },
      key: `m4-target-${repoId}`,
    });
    script = target.script;
    const sub =
      args["workers-subdomain"] ?? new URL(BASE_URL).hostname.split(".").slice(1).join(".");
    const workerUrl = `https://${script}.${sub}`;
    log(`human set the deploy target: ${script} (${workerUrl})`);

    // ------------------------------------------------------------ 4. first production deploy
    const v1 = await agentChange({
      repoId,
      title: "Add GET /version",
      category: "feature",
      edit: (dir) => addVersionRoute(dir),
    });
    await humanApproveAndMerge(v1.id, v1.head);
    mark("v1-merged");
    traffic = new Traffic(workerUrl);
    const deployed = await until(
      v1.id,
      "first deploy",
      (c) => c.rolloutState?.versionId != null,
      (c) =>
        c.status === "merged" &&
        c.rolloutState === null &&
        Date.now() - (marks["v1-merged"] ?? 0) > 600_000
          ? "never deployed"
          : null,
    );
    const v1Version = deployed.rolloutState?.versionId ?? "";
    log(`first version ${v1Version} deployed`);
    traffic.start();

    // ------------------------------------------------------------ 5. the regression
    const bad = await agentChange({
      repoId,
      title: "Speed up / (with a bug that throws for some traffic)",
      category: "feature",
      edit: (dir, changeId) => makeRootThrow(dir, changeId),
    });
    await humanApproveAndMerge(bad.id, bad.head);
    mark("bad-merged");
    log("human is done: from here on, no human input");
    const live = await until(
      bad.id,
      "the bad version to deploy",
      (c) => c.rolloutState?.versionId != null && c.rolloutState.versionId !== v1Version,
    );
    mark("bad-deployed");
    const badVersion = live.rolloutState?.versionId ?? "";
    log(`bad version ${badVersion} is live (previous ${live.rolloutState?.previousVersionId})`);

    // ------------------------------------------------------------ 6. the platform reacts
    const reverted = await until(
      bad.id,
      "the automatic revert",
      (c) => c.revertedBy !== null && c.rolloutState?.status === "rolled-back",
      (c) => (c.status === "released" ? "released despite the regression" : null),
      3000,
    );
    mark("revert-seen");
    const revertId = reverted.revertedBy ?? "";
    log(`reverted by ${revertId}`);

    // Let the rollback settle (and late audit entries land) before reading the timeline.
    await sleep(75_000);

    // Train (if the queue deployed it) → its audit subject.
    const overview = await api<Record<string, unknown>>(
      "GET",
      `/api/v1/repos/${repoId}/queue`,
    ).catch(() => null);
    const trains =
      (
        (overview?.overview ?? overview) as {
          trains?: Array<{ id: string; changeIds: string[]; state: string }>;
        } | null
      )?.trains ?? [];
    const train = trains.find((t) => t.changeIds.includes(bad.id)) ?? null;
    // `train:<repoId>/<id>`; older deploys used `train:<id>` (not unique across repos: time-boxed).
    const subjects = [
      `change:${bad.id}`,
      ...(train ? [`train:${repoId}/${train.id}`, `train:${train.id}`] : []),
    ];
    const audits = await Promise.all(subjects.map(auditOf));
    const since = (marks["bad-merged"] ?? t0) - 60_000;
    const events = audits
      .flatMap((a) => a.events)
      .filter((e) => e.subject.startsWith("change:") || Date.parse(e.at) >= since)
      .sort((a, b) => a.at.localeCompare(b.at) || a.seq - b.seq);
    const firstAt = (...actions: string[]) => {
      const e = events.find((x) => actions.includes(x.action));
      return e === undefined ? null : Date.parse(e.at);
    };
    const detectedAt = firstAt("deploy.regression-attributed", "rollout.regression");
    const flagOffAt = firstAt("deploy.flag-off", "rollout.flag-off");
    const rolledBackAt = firstAt("deploy.train-rolled-back", "rollout.rolled-back");
    const revertOpenedAt = firstAt("change.revert-opened", "rollout.reverted");
    const deployedAt = firstAt("deploy.train-deployed", "rollout.stage");

    const firstError = traffic.firstError(marks["bad-merged"] ?? 0);
    const after = traffic.errorsBetween((rolledBackAt ?? Date.now()) + 45_000);
    // Versions served once the rollback settled: the previous one (or, later, the revert's own
    // deploy, which carries the same code), never the bad one.
    const settledAt = (rolledBackAt ?? Date.now()) + 45_000;
    const lastVersions = [
      ...new Set(traffic.versions.filter((v) => v.at >= settledAt).map((v) => v.version)),
    ];

    // ------------------------------------------------------------ 7. the revert Change
    const revert = await until(
      revertId,
      "the revert to be verified",
      (c) => c.laneReasons.some((r) => r.code === "revert.verified") || c.mergedSha !== null,
      (c) => (c.status === "failing" ? "revert CI failed" : null),
    );
    const revertAudit = await auditOf(`change:${revertId}`);
    const pure = revertAudit.events.some(
      (e) => e.action === "change.revert-verified" && /Verified as a pure revert/.test(e.summary),
    );

    // ------------------------------------------------------------ report
    const base = marks["bad-merged"] ?? t0;
    const rel = (at: number | null) =>
      at === null ? "      -" : `${((at - base) / 1000).toFixed(1).padStart(7)}s`;
    console.log(
      `\n== Timeline (t = 0 at the merge of ${bad.id}; ${train ? `train ${train.id}` : "RolloutWorkflow"})`,
    );
    for (const e of events) {
      if (Date.parse(e.at) < base - 120_000) continue;
      const who = e.principalId.startsWith("hu_") ? "human" : e.principalId;
      console.log(
        `  ${rel(Date.parse(e.at))}  ${e.action.padEnd(32)} ${who.padEnd(22)} ${e.summary}`,
      );
    }
    console.log(`  ${rel(firstError)}  (traffic) first 5xx observed`);
    console.log(`  ${rel(traffic.lastError())}  (traffic) last 5xx observed`);
    const latency = (a: number | null, b: number | null) =>
      a === null || b === null ? "n/a" : `${((b - a) / 1000).toFixed(1)} s`;
    console.log("\n== Latencies");
    console.log(`  deploy → first error seen:      ${latency(deployedAt, firstError)}`);
    console.log(`  first error → detected:         ${latency(firstError, detectedAt)}`);
    console.log(`  detected → flag off:            ${latency(detectedAt, flagOffAt)}`);
    console.log(`  detected → rolled back:         ${latency(detectedAt, rolledBackAt)}`);
    console.log(`  detected → revert opened:       ${latency(detectedAt, revertOpenedAt)}`);
    console.log(
      `  traffic: ${traffic.hits.length} requests, ${traffic.hits.filter((h) => h.status >= 500).length} 5xx`,
    );
    console.log(
      `  after rollback (+45 s): ${after.errors}/${after.total} 5xx; /version → ${lastVersions.join(", ")}`,
    );

    const checks: Array<[string, boolean]> = [
      ["the bad version served errors (traffic saw 5xx)", firstError !== null],
      ["the platform detected the regression", detectedAt !== null],
      ["the change's flag was switched off", flagOffAt !== null],
      [
        "the Worker was rolled back",
        rolledBackAt !== null && reverted.rolloutState?.status === "rolled-back",
      ],
      [
        "traffic is back on the previous version",
        lastVersions.includes(v1Version) && !lastVersions.includes(badVersion),
      ],
      ["no errors after the rollback settled", after.total > 0 && after.errors === 0],
      [`revert ${revertId} opened (revertOf ${revert.revertOf})`, revert.revertOf === bad.id],
      [
        "the revert is a verified pure revert",
        pure || revert.laneReasons.some((r) => r.code === "revert.verified"),
      ],
      [
        "no human acted after the review",
        events.filter((e) => Date.parse(e.at) > base && e.principalId.startsWith("hu_")).length ===
          0,
      ],
      ["the audit chain verifies", audits.every((a) => a.verified) && revertAudit.verified],
    ];
    console.log("\n== Checks");
    for (const [name, pass] of checks) console.log(`  ${pass ? "✓" : "✗"} ${name}`);
    console.log(`\n  project ${repoId}, change ${bad.id}, revert ${revertId}, worker ${workerUrl}`);
    const passed = checks.every(([, p]) => p);
    log(passed ? "✓ M4 passed" : "✗ M4 failed");
    process.exitCode = passed ? 0 : 1;
  } finally {
    await traffic?.stop();
    await mcp.client.close();
    rmSync(workdir, { recursive: true, force: true });
    if (script !== null && !args.keep) {
      // The project's Worker lives in the platform's account: delete it with your own wrangler login.
      const res = spawnSync("pnpm", ["exec", "wrangler", "delete", "--name", script, "--force"], {
        cwd: join(import.meta.dirname, "../../apps/platform"),
        encoding: "utf8",
      });
      log(
        res.status === 0
          ? `deleted Worker ${script}`
          : `could not delete ${script}: ${(res.stderr ?? "").slice(-300)}`,
      );
    } else if (script !== null) log(`kept Worker ${script}`);
  }
}

await main().catch((e: unknown) => die(e instanceof Error ? (e.stack ?? e.message) : String(e)));
