/**
 * Merge queue acceptance against a DEPLOYED platform (not run in CI): three Changes go through
 * the agent-native merge queue; two of them edit the same README line, so the second one needs
 * the resolver agent (a textual conflict resolved by `system:resolver`, never the author).
 *
 *   pnpm tsx scripts/e2e/merge-queue.ts --url https://gittifacts.<you>.workers.dev --token gtf_… \
 *     [--repo <repoId>] [--reviewer-cookie '<better-auth session cookie>'] [--timeout-min 60]
 *
 * Steps: whoami → 3× start_change, clone the fork, commit, push → enqueue each (options + where it
 * stands) → wait for lanes; Lane ≥ 1 Changes need a human approval: with --reviewer-cookie the
 * script approves as that human (POST /api/v1/changes/{id}/review), else it prints the review
 * links and keeps waiting → wait_for_merge until each merged (or ejected, with its fix) →
 * read the queue's SSE events: entered_batch / merged for all three, resolving_conflict +
 * resolution_ready for the conflicting pair → queue_overview. Exits 0 when all three merged and
 * the conflict was resolved in the queue.
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
    token: { type: "string" },
    repo: { type: "string" },
    "reviewer-cookie": { type: "string" },
    "timeout-min": { type: "string", default: "60" },
    keep: { type: "boolean", default: false },
  },
});

const BASE_URL = (args.url ?? process.env.GITTIFACTS_URL ?? "").replace(/\/+$/, "");
const TOKEN = args.token ?? process.env.GITTIFACTS_TOKEN ?? "";
const COOKIE = args["reviewer-cookie"] ?? process.env.GITTIFACTS_REVIEWER_COOKIE ?? "";
const DEADLINE = Date.now() + Number(args["timeout-min"]) * 60_000;
const t0 = Date.now();
const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const log = (message: string) => console.log(`[${elapsed().padStart(7)}] ${message}`);

function die(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}
if (BASE_URL === "" || TOKEN === "")
  die("pass --url and --token (or GITTIFACTS_URL / GITTIFACTS_TOKEN)");

interface Grant {
  url: string;
  token: string;
  branch: string;
}

/** git with the grant as an Authorization header from the environment (never argv). */
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

/** The queue's §5 events so far (reads the SSE stream from the start for `ms`). */
async function queueEvents(
  repoId: string,
  ms = 4000,
): Promise<{ type: string; changeId?: string }[]> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  const out: { type: string; changeId?: string }[] = [];
  try {
    const res = await fetch(`${BASE_URL}/api/v1/repos/${repoId}/queue/events?since=0`, {
      headers: { authorization: `Bearer ${TOKEN}`, accept: "text/event-stream" },
      signal: ctl.signal,
    });
    if (!res.ok || res.body === null) die(`queue events: HTTP ${res.status}`);
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

/** Approve as a human (better-auth session cookie): agents can never approve. */
async function approve(changeId: string): Promise<boolean> {
  if (COOKIE === "") return false;
  const res = await fetch(`${BASE_URL}/api/v1/changes/${changeId}/review`, {
    method: "POST",
    headers: { cookie: COOKIE, "content-type": "application/json", origin: BASE_URL },
    body: JSON.stringify({ decision: "approve" }),
  });
  if (!res.ok) log(`approve ${changeId}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.ok;
}

interface Planned {
  name: string;
  id: string;
  title: string;
}

async function main(): Promise<void> {
  log(`platform ${BASE_URL}`);
  const mcp: PlatformClient = await createPlatformClient(`${BASE_URL}/mcp`, TOKEN, {
    clientName: "gittifacts-e2e-merge-queue",
  });
  const workdir = mkdtempSync(join(tmpdir(), "gittifacts-mq-"));
  try {
    const me = ok("whoami", await mcp.tools.whoami());
    const repo =
      args.repo !== undefined
        ? me.repos.find((r) => r.id === args.repo)
        : me.repos.find((r) => r.actions.includes("start-change"));
    if (repo === undefined) die("no repo this agent may start changes on; pass --repo");
    log(`repo ${repo.name} (${repo.id}), ${repo.claim.status}`);

    // ------------------------------------------------------------ three Changes, one conflicting pair
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const changes: Planned[] = [];
    for (const name of ["A", "B", "C"]) {
      const { change, remote } = ok(
        `start_change ${name}`,
        await mcp.tools.start_change({
          repoId: repo.id,
          title: `Merge queue e2e ${name} ${stamp}`,
          category: "docs",
          idempotencyKey: `mq-e2e-${stamp}-${name}`,
        }),
      );
      const dir = join(workdir, name);
      git(workdir, remote, ["clone", "--quiet", "--branch", remote.branch, remote.url, dir]);
      if (name === "A") {
        writeFileSync(
          join(dir, `MQ-E2E-${stamp}.md`),
          `# Merge queue e2e\n\nIndependent Change A.\n`,
        );
      } else {
        // B and C rewrite the same README line: whichever lands second conflicts.
        const readme = join(dir, "README.md");
        const lines = (() => {
          try {
            return readFileSync(readme, "utf8").split("\n");
          } catch {
            return ["# README"];
          }
        })();
        lines[0] = `${lines[0] ?? "#"} (queue e2e ${name} ${stamp})`;
        writeFileSync(readme, lines.join("\n"));
      }
      git(dir, remote, ["add", "-A"]);
      git(dir, remote, [
        "-c",
        "user.name=gittifacts e2e",
        "-c",
        "user.email=e2e@gittifacts.dev",
        "commit",
        "--quiet",
        "-m",
        `merge queue e2e ${name}`,
      ]);
      git(dir, remote, ["push", "--quiet", "origin", `HEAD:refs/heads/${remote.branch}`]);
      log(`${name}: change ${change.id} pushed`);
      changes.push({ name, id: change.id, title: change.title });
    }

    // ------------------------------------------------------------ enqueue (options; admission on approval)
    for (const c of changes) {
      const r = ok(
        `enqueue ${c.name}`,
        await mcp.tools.enqueue({
          changeId: c.id,
          idempotencyKey: `mq-e2e-${stamp}-enq-${c.name}`,
        }),
      );
      log(
        `${c.name}: admitted=${r.admitted} state=${r.state} position=${r.position} track=${r.track ?? "-"} eta=${r.etaSeconds}s p=${r.predictedPassProbability} — ${r.reason}`,
      );
    }

    // ------------------------------------------------------------ approvals, then the merges
    const outcome = new Map<string, string>();
    const approved = new Set<string>();
    let lastNote = "";
    while (outcome.size < changes.length && Date.now() < DEADLINE) {
      for (const c of changes) {
        if (outcome.has(c.id)) continue;
        const st = ok(
          `get_change_status ${c.name}`,
          await mcp.tools.get_change_status({ changeId: c.id }),
        );
        if (st.change.status === "awaiting-review" && !approved.has(c.id)) {
          if (await approve(c.id)) {
            approved.add(c.id);
            log(`${c.name}: approved by the reviewer (Lane ${st.change.lane})`);
          } else {
            const note = `${c.name}: Lane ${st.change.lane}, waiting for a human review at ${BASE_URL}/changes/${c.id}`;
            if (note !== lastNote) log(note);
            lastNote = note;
          }
        }
        if (st.change.status === "failing" || st.change.status === "rejected") {
          const q = ok(`queue_status ${c.name}`, await mcp.tools.queue_status({ changeId: c.id }));
          const r = q.status?.ejectReason;
          die(
            `${c.name} is ${st.change.status}${r ? `: ejected (${r.code}) ${r.message} — fix: ${r.fix.call ?? r.fix.explanation}` : ""}`,
          );
        }
        const w = ok(
          `wait_for_merge ${c.name}`,
          await mcp.tools.wait_for_merge({ changeId: c.id, timeoutSec: 20 }),
        );
        if (w.reason === "merged" || w.reason === "ejected" || w.reason === "dequeued") {
          outcome.set(c.id, w.reason);
          log(
            `${c.name}: ${w.reason}${w.status?.mergedSha ? ` as ${w.status.mergedSha.slice(0, 12)}` : ""}`,
          );
          if (w.reason === "ejected")
            die(
              `${c.name} ejected: ${w.status?.ejectReason?.message} — fix: ${w.status?.ejectReason?.fix.call}`,
            );
        } else if (w.status !== null) {
          log(
            `${c.name}: ${w.status.state}${w.status.trackId ? ` (track ${w.status.trackId})` : ""} — ${w.status.reason}`,
          );
        }
      }
    }
    if (outcome.size < changes.length) die("timed out before every Change merged");

    // ------------------------------------------------------------ what the queue did
    const events = await queueEvents(repo.id);
    const of = (type: string) => events.filter((e) => e.type === type).map((e) => e.changeId);
    const ids = changes.map((c) => c.id);
    for (const id of ids) {
      if (!of("entered_batch").includes(id)) die(`no entered_batch event for ${id}`);
      if (!of("merged").includes(id)) die(`no merged event for ${id}`);
    }
    const resolved = of("resolution_ready").filter((id) => id !== undefined && ids.includes(id));
    if (resolved.length === 0)
      die(
        "B and C both landed but no resolution_ready event: was the conflict resolved in the queue?",
      );
    log(
      `resolver resolved the README conflict for ${resolved.join(", ")} (resolving_conflict → resolution_ready)`,
    );
    const o = ok("queue_overview", await mcp.tools.queue_overview({ repoId: repo.id }));
    log(
      `queue: main ${o.mainSha.slice(0, 12)}, frozen=${o.frozen}, ${o.throughputPerHour} merged/h, p50 ${o.timeInQueueMs.p50 ?? "-"} ms, p95 ${o.timeInQueueMs.p95 ?? "-"} ms`,
    );
    console.log(
      `✓ three Changes merged through the merge queue, one conflict resolved, in ${elapsed()}`,
    );
  } finally {
    if (!args.keep) rmSync(workdir, { recursive: true, force: true });
    await mcp.client.close();
  }
}

await main();
