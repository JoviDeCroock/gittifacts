/**
 * Many agents, one repo, at the same time, against a DEPLOYED platform (not run in CI). The live
 * counterpart of apps/platform/test/integration/many-agents.test.ts and the demo for Cloudflare's
 * "next Git platform" brief, which asks at a minimum for multiple agents working on changes
 * concurrently (DECISIONS 2026-10-10).
 *
 * A human signs in and registers N agent principals (each its own token, owned by that human).
 * Every agent then: start_change (with the paths it means to touch) → clone its fork → commit →
 * push → get_change_status → enqueue. Agent 1 starts first and the rest at once. Agents 1 and 2
 * both say README.md and rewrite the same README line, so agent 2's start_change is told that
 * agent 1 is on it (overlaps), and whichever lands second needs the resolver (`system:resolver`,
 * never the author). Every overlap an agent is told about is logged. The human approves each Change
 * as it reaches review (agents never can), and approves the resolution again when the resolver
 * wrote lines of its own (the Change goes back to awaiting-review); the queue lands them all. A
 * poll the MCP client times out on is asked again. Prints a timeline and a
 * summary, then revokes the agents' tokens.
 *
 *   GITTIFACTS_EMAIL=… GITTIFACTS_PASSWORD=… pnpm tsx scripts/e2e/many-agents.ts \
 *     --url https://gittifacts.<you>.workers.dev --repo <repoId> [--agents 6] [--timeout-min 60]
 *
 * or `--reviewer-cookie '<better-auth session cookie>'` instead of the email and password (never
 * pass a password on the command line). The human must be a reviewer (or above) on the repo.
 * Exits 0 when every Change merged, each attributed to the agent that wrote it, agent 2 was told
 * at start_change that agent 1 works on README.md, and the README conflict was resolved in the queue.
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
    repo: { type: "string" },
    agents: { type: "string", default: "6" },
    "reviewer-cookie": { type: "string" },
    "timeout-min": { type: "string", default: "60" },
    keep: { type: "boolean", default: false },
  },
});

const BASE_URL = (args.url ?? process.env.GITTIFACTS_URL ?? "").replace(/\/+$/, "");
const REPO_ID = args.repo ?? process.env.GITTIFACTS_REPO ?? "";
const N = Number(args.agents);
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
if (!Number.isInteger(N) || N < 2 || N > 20) die("--agents must be an integer from 2 to 20");

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
async function asHuman<T>(cookie: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      cookie,
      origin: BASE_URL,
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

/** The queue's events so far (reads the SSE stream from the start for `ms`). */
async function queueEvents(
  token: string,
  ms = 4000,
): Promise<{ type: string; changeId?: string }[]> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  const out: { type: string; changeId?: string }[] = [];
  try {
    const res = await fetch(`${BASE_URL}/api/v1/repos/${REPO_ID}/queue/events?since=0`, {
      headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" },
      signal: ctl.signal,
    });
    if (!res.ok || res.body === null) throw new Error(`queue events: HTTP ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i = buf.indexOf("\n\n");
      while (i >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = block
          .split("\n")
          .filter((l) => l.startsWith("data: "))
          .map((l) => l.slice(6))
          .join("\n");
        if (block.includes("event: queue") && data !== "") out.push(JSON.parse(data));
        i = buf.indexOf("\n\n");
      }
    }
  } catch (e) {
    if (!(e instanceof Error && e.name === "AbortError")) throw e;
  } finally {
    clearTimeout(timer);
  }
  return out;
}

interface Agent {
  label: string;
  i: number;
  principalId: string;
  token: string;
  mcp: PlatformClient;
}

/** One overlap an agent was told about, and when (at start_change or in get_change_status). */
interface Told {
  agent: string;
  when: "start" | "status";
  changeId: string;
  other: string;
  why: string;
}
const told: Told[] = [];

/** "many-agents agent-1 <stamp>" → "agent-1": the label the other agent goes by in this run. */
function labelOf(name: string): string {
  return /^many-agents (agent-\d+) /.exec(name)?.[1] ?? name;
}

type OverlapReport = {
  overlaps: Array<{
    changeId: string;
    author: { name: string };
    reasons: Array<{ code: string; message: string; paths: string[]; morePaths: number }>;
  }>;
} | null;

/** Log (and remember) each overlap: `agent-2  told: overlaps agent-1's <id> (same paths: README.md)`. */
function tell(a: Agent, when: Told["when"], report: OverlapReport): void {
  if (report === null) {
    log(a.label, `${when === "start" ? "told" : "status"}: overlaps not checked (null)`);
    return;
  }
  for (const o of report.overlaps) {
    const other = labelOf(o.author.name);
    const why = o.reasons
      .map((r) =>
        r.code === "same-paths"
          ? `same paths: ${r.paths.join(", ")}${r.morePaths > 0 ? ` +${r.morePaths}` : ""}`
          : r.code.replace("-", " "),
      )
      .join("; ");
    told.push({ agent: a.label, when, changeId: o.changeId, other, why });
    log(
      a.label,
      `${when === "start" ? "told" : "status"}: overlaps ${other}'s ${o.changeId} (${why})`,
    );
  }
}

/** The paths an agent says it will touch: agents 1 and 2 share README.md; the rest their own note. */
const pathsOf = (i: number, stamp: string) => (i <= 2 ? ["README.md"] : [`AGENT-${stamp}-${i}.md`]);

interface Started {
  agent: Agent;
  changeId: string;
  remote: Grant;
}

/** start_change with the paths it means to touch; logs what it was told about other agents. */
async function startWork(a: Agent, stamp: string): Promise<Started> {
  const { change, remote, overlaps } = ok(
    `start_change ${a.label}`,
    await a.mcp.tools.start_change({
      repoId: REPO_ID,
      title: `Many agents ${a.label} ${stamp}`,
      category: "docs",
      summary: `Agent ${a.i} of ${N}, working concurrently with the others.`,
      paths: pathsOf(a.i, stamp),
      idempotencyKey: `many-agents-${stamp}-${a.i}`,
    }),
  );
  log(a.label, `started ${change.id} on its own fork (paths: ${pathsOf(a.i, stamp).join(", ")})`);
  tell(a, "start", overlaps);
  return { agent: a, changeId: change.id, remote };
}

interface Work {
  agent: Agent;
  changeId: string;
  queuedAt: number;
  mergedAt?: number;
  outcome?: string;
  mergedSha?: string;
}

/** One agent's part after its start, concurrently with the others: clone → commit → push → status → enqueue. */
async function agentWork(s: Started, workdir: string, stamp: string): Promise<Work> {
  const { agent: a, remote } = s;
  const change = { id: s.changeId };
  const dir = join(workdir, a.label);
  git(workdir, remote, ["clone", "--quiet", "--branch", remote.branch, remote.url, dir]);
  if (a.i <= 2) {
    // Agents 1 and 2 rewrite the same README line: whichever lands second conflicts.
    const readme = join(dir, "README.md");
    let lines = ["# README"];
    try {
      lines = readFileSync(readme, "utf8").split("\n");
    } catch {}
    lines[0] = `${lines[0] ?? "#"} (${a.label} ${stamp})`;
    writeFileSync(readme, lines.join("\n"));
  } else {
    writeFileSync(join(dir, `AGENT-${stamp}-${a.i}.md`), `# ${a.label}\n\nIndependent work.\n`);
  }
  git(dir, remote, ["add", "-A"]);
  git(dir, remote, [
    "-c",
    `user.name=gittifacts ${a.label}`,
    "-c",
    "user.email=agents@gittifacts.dev",
    "commit",
    "--quiet",
    "-m",
    `${a.label}: ${a.i <= 2 ? "README headline" : "independent note"}`,
  ]);
  git(dir, remote, ["push", "--quiet", "origin", `HEAD:refs/heads/${remote.branch}`]);
  log(a.label, "pushed; grading starts on the push event");
  const st = ok("get_change_status", await a.mcp.tools.get_change_status({ changeId: change.id }));
  tell(a, "status", st.overlaps);
  const q = ok(
    `enqueue ${a.label}`,
    await a.mcp.tools.enqueue({
      changeId: change.id,
      idempotencyKey: `many-agents-${stamp}-enq-${a.i}`,
    }),
  );
  log(a.label, `enqueued: ${q.state} (${q.reason})`);
  return { agent: a, changeId: change.id, queuedAt: Date.now() };
}

/** What GET /changes/:id/resolution says (the parts the human's log line uses). */
interface Resolution {
  headSha: string;
  kind: "textual" | "semantic";
  lane: number | null;
  approvalRequested: boolean;
  upstream: { changeId: string }[];
  item: { novelLines: number; touchesOutsideConflictHunks: boolean } | null;
}

/**
 * A poll the MCP SDK gave up on (it times a request out after 60 s, e.g. while the queue's Durable
 * Object is busy) is asked again on the next round instead of ending the run; anything else, or
 * five timeouts in a row for one agent, still fails it.
 */
const timeouts = new Map<string, number>();
async function poll<T>(who: string, what: string, call: () => Promise<T>): Promise<T | null> {
  try {
    const out = await call();
    timeouts.delete(who);
    return out;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const n = (timeouts.get(who) ?? 0) + 1;
    if (!/timed out|timeout|fetch failed|ECONNRESET|socket hang up/i.test(message) || n >= 5)
      throw e;
    timeouts.set(who, n);
    log(who, `${what} did not answer (${message}); asking again`);
    return null;
  }
}

/** Waits are bounded server-side (timeoutSec); the request may take that plus slack. */
const WAIT_SEC = 20;
const WAIT_REQUEST = { timeout: (WAIT_SEC + 70) * 1000 };

/**
 * The human approves each Change once it reaches review, and approves again when the queue's
 * resolver rewrote one and the resolution asks for it (the Change is back in awaiting-review and
 * GET /changes/:id/resolution says approvalRequested). Every agent waits for its own merge.
 */
async function untilLanded(cookie: string, work: Work[]): Promise<void> {
  const approved = new Set<string>();
  const resolutions = new Set<string>(); // `${changeId}@${resolved head}` the human approved
  const waiting = new Set<string>();
  const agentOf = (id: string) => work.find((w) => w.changeId === id)?.agent.label ?? id;
  const approve = async (w: Work, what: string): Promise<boolean> => {
    const r = await asHuman(cookie, "POST", `/api/v1/changes/${w.changeId}/review`, {
      decision: "approve",
    });
    if (r.ok) return true;
    const key = `${what} ${w.changeId}`;
    if (!waiting.has(key)) {
      waiting.add(key);
      log("human", `can't approve ${w.agent.label}'s ${what} yet: HTTP ${r.status}`);
    }
    return false;
  };
  while (work.some((w) => w.outcome === undefined) && Date.now() < DEADLINE) {
    await Promise.all(
      work
        .filter((w) => w.outcome === undefined)
        .map(async (w) => {
          const a = w.agent;
          const res = await poll(a.label, "get_change_status", () =>
            a.mcp.tools.get_change_status({ changeId: w.changeId }),
          );
          if (res === null) return;
          const st = ok("get_change_status", res);
          if (st.change.status === "awaiting-review" && !approved.has(w.changeId)) {
            if (await approve(w, "Change")) {
              approved.add(w.changeId);
              log("human", `approved ${a.label}'s Change (Lane ${st.change.lane})`);
            }
          } else if (st.change.status === "awaiting-review") {
            // Back in review after the first approval: the queue's resolver rewrote it.
            const r = await asHuman<{ resolution: Resolution | null }>(
              cookie,
              "GET",
              `/api/v1/changes/${w.changeId}/resolution`,
            );
            const res = r.ok ? r.body.resolution : null;
            const key = `${w.changeId}@${res?.headSha}`;
            if (
              res?.approvalRequested === true &&
              !resolutions.has(key) &&
              (await approve(w, "resolution"))
            ) {
              resolutions.add(key);
              const upstream =
                res.upstream.map((u) => agentOf(u.changeId)).join(", ") || "upstream";
              const novel = res.item?.novelLines ?? 0;
              log(
                "human",
                `approved ${a.label}'s resolution (Lane ${res.lane ?? st.change.lane}, ${res.kind} conflict with ${upstream}, ${novel} new line${novel === 1 ? "" : "s"}${res.item?.touchesOutsideConflictHunks ? ", outside the hunks" : ""}, resolved head ${res.headSha.slice(0, 12)})`,
              );
            }
          }
          if (st.change.status === "failing" || st.change.status === "rejected")
            throw new Error(`${a.label}'s Change is ${st.change.status}`);
          const waited = await poll(a.label, "wait_for_merge", () =>
            a.mcp.tools.wait_for_merge(
              { changeId: w.changeId, timeoutSec: WAIT_SEC },
              WAIT_REQUEST,
            ),
          );
          if (waited === null) return;
          const m = ok("wait_for_merge", waited);
          if (m.reason === "merged" || m.reason === "ejected" || m.reason === "dequeued") {
            w.outcome = m.reason;
            w.mergedAt = Date.now();
            w.mergedSha = m.status?.mergedSha ?? undefined;
            log(a.label, `${m.reason}${w.mergedSha ? ` as ${w.mergedSha.slice(0, 12)}` : ""}`);
            if (m.reason === "ejected")
              throw new Error(
                `${a.label} ejected: ${m.status?.ejectReason?.message} — fix: ${m.status?.ejectReason?.fix.call}`,
              );
          }
        }),
    );
  }
  if (work.some((w) => w.outcome === undefined))
    throw new Error("timed out before every Change landed");
}

async function main(): Promise<void> {
  log("human", `platform ${BASE_URL}, repo ${REPO_ID}, ${N} agents`);
  const cookie = await humanCookie();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const agents: Agent[] = [];
  const workdir = mkdtempSync(join(tmpdir(), "gittifacts-agents-"));
  try {
    // ------------------------------------------------------------ N agent principals, one owner
    for (let i = 1; i <= N; i++) {
      const label = `agent-${i}`;
      const r = await asHuman<{ principal: { id: string }; token: string }>(
        cookie,
        "POST",
        "/api/v1/principals/agents",
        {
          name: `many-agents ${label} ${stamp}`,
          scopes: ["repo:read", "plan:create", "change:create"],
          expiresInDays: 1,
        },
      );
      if (!r.ok) throw new Error(`registering ${label}: HTTP ${r.status}`);
      const mcp = await createPlatformClient(`${BASE_URL}/mcp`, r.body.token, {
        clientName: `gittifacts-many-agents-${i}`,
      });
      agents.push({ label, i, principalId: r.body.principal.id, token: r.body.token, mcp });
      log(label, `registered as ${r.body.principal.id}`);
    }

    // ------------------------------------------------------------ agent 1 first, then all at once
    // Agent 1 starts a moment ahead, so agent 2's start_change is told about it on camera.
    const first = await startWork(agents[0]!, stamp);
    const rest = await Promise.all(agents.slice(1).map((a) => startWork(a, stamp)));
    const work = await Promise.all([first, ...rest].map((s) => agentWork(s, workdir, stamp)));
    await untilLanded(cookie, work);

    // ------------------------------------------------------------ what landed, and who wrote it
    for (const w of work) {
      const r = await asHuman<{ change: { authorId: string } }>(
        cookie,
        "GET",
        `/api/v1/changes/${w.changeId}`,
      );
      if (r.body.change.authorId !== w.agent.principalId)
        throw new Error(`${w.agent.label}'s Change is attributed to ${r.body.change.authorId}`);
    }
    const events = await queueEvents(agents[0]!.token);
    const ids = new Set(work.map((w) => w.changeId));
    const resolved = events.filter(
      (e) => e.type === "resolution_ready" && ids.has(e.changeId ?? ""),
    );
    if (resolved.length === 0)
      throw new Error(
        "agents 1 and 2 both landed but no resolution_ready event: was the conflict resolved in the queue?",
      );
    const o = ok("queue_overview", await agents[0]!.mcp.tools.queue_overview({ repoId: REPO_ID }));

    // ------------------------------------------------------------ who was told about whom
    console.log("\nagent     told about (start = at start_change, status = after its push)");
    for (const a of agents) {
      const mine = told.filter((t) => t.agent === a.label);
      const seen = [...new Map(mine.map((t) => [`${t.when} ${t.changeId}`, t])).values()];
      console.log(
        `${a.label.padEnd(9)} ${seen.length === 0 ? "nothing" : seen.map((t) => `${t.when}: ${t.other}'s ${t.changeId} (${t.why})`).join("; ")}`,
      );
    }
    const pairFirst = first.changeId;
    if (!told.some((t) => t.agent === "agent-2" && t.when === "start" && t.changeId === pairFirst))
      throw new Error(
        `agent-2 was not told at start_change that agent-1 (${pairFirst}) works on README.md`,
      );

    console.log("\nagent     change                 queue → merged   merged sha");
    for (const w of work)
      console.log(
        `${w.agent.label.padEnd(9)} ${w.changeId.padEnd(22)} ${(((w.mergedAt ?? 0) - w.queuedAt) / 1000).toFixed(0).padStart(6)} s       ${(w.mergedSha ?? "-").slice(0, 12)}`,
      );
    console.log(
      `\nqueue: main ${o.mainSha.slice(0, 12)}, ${o.throughputPerHour} merged/h, p50 ${o.timeInQueueMs.p50 ?? "-"} ms, p95 ${o.timeInQueueMs.p95 ?? "-"} ms`,
    );
    console.log(
      `✓ ${N} agents, ${N} Changes merged concurrently, each attributed to its agent; agent-2 was told agent-1 was on README.md before either pushed; the README conflict resolved by system:resolver, in ${elapsed()}`,
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
