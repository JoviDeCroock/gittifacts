/**
 * `gittifacts ship`: from a clone, get the commits at HEAD in front of a reviewer.
 *
 * 1. The Change in `.gittifacts.json` still open: push HEAD to its fork. Otherwise (none yet,
 *    merged, closed) start_change (title: the last commit's subject), repoint `origin` at the
 *    new fork, then push.
 * 2. Wait for the evidence and the lane (wait_for_change, for the head just pushed).
 * 3. Print the lane by name, the reasons that set it, the Change's page and one next step.
 *
 * Exit 0 with a lane; 3 when CI failed, the wait timed out or the Change ended; 1 on errors.
 */
import { dirname } from "node:path";
import { withCommands } from "../calls.js";
import {
  adoptChange,
  gitOut,
  parsePushRemote,
  type WiringResult,
  workTreeRoot,
} from "../clone-setup.js";
import type { Ctx } from "../context.js";
import { CliError, cliError, EXIT } from "../errors.js";
import { gitAuthEnv } from "../git.js";
import { shipSummary, shipText } from "../ship-view.js";
import { bundledCommands, findCommand } from "../tools/commands.js";
import { type Builtin, builtinSpec, int, str } from "./builtin.js";
import { callTool } from "./tool.js";
import { waitForMilestone } from "./wait.js";

/** A Change that can't take a new head any more. */
const ENDED = new Set(["merged", "rolling-out", "released", "reverted", "rejected", "abandoned"]);
export const SHIP_TIMEOUT_SEC = 900;

function categories(): string[] {
  const flag = findCommand("start_change")?.flags.find((f) => f.property === "category");
  return (flag?.values ?? []).map(String);
}

const spec = builtinSpec({
  command: "ship",
  tool: "start_change",
  title: "Ship HEAD",
  description:
    "Push HEAD to this clone's open Change (or start one: start_change, then point origin at its fork), wait for CI and the lane, and print the lane, why, the Change's page and the next step.",
  mutating: true,
  properties: {
    title: {
      type: "string",
      description: "A new Change's title (default: the last commit subject).",
    },
    plan: { type: "string", description: "The approved plan a new Change implements (planId)." },
    category: { enum: categories(), description: "A new Change's category (default feature)." },
    timeout: {
      type: "integer",
      description: `Seconds to wait for the lane (default ${SHIP_TIMEOUT_SEC}).`,
    },
    wait: { type: "boolean", description: "Wait for the lane (default true; --no-wait to skip)." },
  },
});

function need<T>(
  value: T | null | undefined,
  message: string,
  explanation: string,
  command?: string,
): T {
  if (value === null || value === undefined) {
    throw cliError("ship", message, { explanation, ...(command ? { command } : {}) });
  }
  return value;
}

export const ship: Builtin = {
  spec,
  examples: ["gittifacts ship", 'gittifacts ship --title "Rate limit logins" --category fix'],
  async run(ctx, parsed) {
    const io = ctx.io;
    const dir = need(
      await workTreeRoot(io, io.cwd),
      "not inside a git clone",
      "Run ship from a clone: `gittifacts init --clone` or `gittifacts clone <repoId>` make one.",
      "gittifacts clone <repoId>",
    );
    const found = need(
      ctx.project(),
      "this clone has no .gittifacts.json",
      "ship needs to know the repo. Clone it with `gittifacts clone <repoId>` (or run `gittifacts init`).",
      "gittifacts clone <repoId>",
    );
    const head = need(
      await gitOut(io, dir, ["rev-parse", "--verify", "-q", "HEAD"]),
      "nothing committed yet",
      "Commit your edits first; ship pushes HEAD.",
      'git add -A && git commit -m "<what changed>"',
    );
    const target = ctx.target();
    const cfg = found.config;
    const key = ctx.globals.idempotencyKey ?? ctx.newIdempotencyKey();

    let current: Record<string, unknown> | null = null;
    if (cfg.changeId) {
      const status = findCommand("get_change_status");
      if (status) {
        current = await callTool(ctx, target, status, { changeId: cfg.changeId }).catch((e) => {
          if (e instanceof CliError && e.body.code === "not-found") return null;
          throw e;
        });
      }
    }
    const change = current?.change as Record<string, unknown> | undefined;
    const reuse = change !== undefined && !ENDED.has(String(change.status));
    let changeId = cfg.changeId ?? "";
    let wiring: WiringResult;
    let pushToken: string;
    let branch: string;

    if (reuse) {
      const refresh = need(
        findCommand("refresh_push_token"),
        "this CLI has no refresh_push_token",
        "Update the CLI.",
      );
      const doc = await callTool(
        ctx,
        target,
        refresh,
        { changeId },
        { idempotencyKey: ctx.newIdempotencyKey() },
      );
      const remote = need(
        parsePushRemote(doc.remote),
        "refresh_push_token returned no token",
        "Retry.",
      );
      pushToken = remote.token;
      branch = remote.branch;
      // Idempotent: also wires a clone made before ship existed.
      wiring = await adoptChange(io, {
        dir,
        projectDir: dirname(found.path),
        config: cfg,
        changeId,
        remote,
      });
    } else {
      const dirty = await gitOut(io, dir, ["status", "--porcelain"]);
      if (dirty) ctx.out.progress("uncommitted edits are not shipped; commit them and ship again");
      const title =
        str(parsed, "title") ?? (await gitOut(io, dir, ["log", "-1", "--format=%s"])) ?? "Update";
      const start = need(
        findCommand("start_change"),
        "this CLI has no start_change",
        "Update the CLI.",
      );
      const plan = str(parsed, "plan");
      const doc = await callTool(
        ctx,
        target,
        start,
        {
          repoId: cfg.projectId,
          title: title.slice(0, 200),
          category: str(parsed, "category") ?? "feature",
          ...(plan ? { planId: plan } : {}),
        },
        { idempotencyKey: key },
      );
      const started = doc.change as Record<string, unknown> | undefined;
      const remote = need(
        parsePushRemote(doc.remote),
        "start_change returned no fork to push to",
        "Retry with the same --idempotency-key.",
      );
      changeId = need(
        typeof started?.id === "string" ? started.id : null,
        "start_change returned no Change id",
        "Retry with the same --idempotency-key.",
      );
      ctx.out.progress(`started ${changeId}: ${title}`);
      wiring = await adoptChange(io, {
        dir,
        projectDir: dirname(found.path),
        config: cfg,
        changeId,
        remote,
      });
      pushToken = remote.token;
      branch = remote.branch;
    }

    const pushed = await pushHead(ctx, {
      dir,
      branch,
      token: pushToken,
      head,
      already: reuse && change?.headSha === head,
    });
    return report(ctx, parsed, { target, changeId, head, pushed, wiring, started: !reuse, key });
  },
};

/** Pushes HEAD to the fork's branch (the token in git's environment); the short sha, or null. */
async function pushHead(
  ctx: Ctx,
  o: { dir: string; branch: string; token: string; head: string; already: boolean },
): Promise<string | null> {
  const short = o.head.slice(0, 12);
  if (o.already) {
    ctx.out.progress(`${short} is already on the fork`);
    return null;
  }
  ctx.out.progress(`pushing ${short} to the fork's ${o.branch}`);
  const r = await ctx.io.git(["push", "origin", `HEAD:refs/heads/${o.branch}`], {
    cwd: o.dir,
    env: gitAuthEnv({ scheme: "Bearer", token: o.token }),
  });
  if (r.code === 0) return short;
  const last = r.stderr.trim().split("\n").filter(Boolean).slice(-3).join(" ");
  if (/non-fast-forward|fetch first|\[rejected\]/.test(r.stderr)) {
    throw cliError("push-rejected", `the fork has commits HEAD doesn't: ${last}`, {
      explanation:
        "A new Change's fork starts at the latest default branch. Rebase onto it, then ship again.",
      command: "git pull --rebase && gittifacts ship",
    });
  }
  throw cliError("push-failed", `git push failed (exit ${r.code}): ${last}`, {
    explanation: /\b40[13]\b/.test(r.stderr)
      ? "The fork refused the push token. Ship again for a fresh one; only the Change's author can push."
      : "Read git's message; ship again once it is fixed.",
    command: "gittifacts ship",
  });
}

interface ReportInput {
  target: ReturnType<Ctx["target"]>;
  changeId: string;
  head: string;
  pushed: string | null;
  wiring: WiringResult;
  started: boolean;
  key: string;
}

/** Waits for the evidence of the head just pushed, then the lane, and prints the summary. */
async function report(
  ctx: Ctx,
  parsed: Parameters<Builtin["run"]>[1],
  r: ReportInput,
): Promise<number> {
  const timeoutSec = int(parsed, "timeout") ?? SHIP_TIMEOUT_SEC;
  const wait = parsed.values.wait !== false;
  const deadline = ctx.io.now() + timeoutSec * 1000;
  const left = () => Math.ceil((deadline - ctx.io.now()) / 1000);
  let waited = 0;
  let outcome = "not waited";
  let last: Record<string, unknown> = {};
  if (wait) {
    for (const until of ["evidence_ready", "lane_assigned"] as const) {
      for (;;) {
        if (left() <= 0) break;
        const w = await waitForMilestone(ctx, r.target, {
          changeId: r.changeId,
          until,
          timeoutSec: left(),
        });
        waited += w.seconds;
        const ch = (w.result.change ?? {}) as Record<string, unknown>;
        last = ch;
        outcome = String(w.result.reason ?? "timeout");
        // Reached for an older head: the platform hasn't seen the push yet.
        if (w.result.reached === true && ch.headSha !== r.head && left() > 2) {
          await ctx.io.sleep(2000);
          continue;
        }
        break;
      }
      if (outcome !== "reached") break;
      // CI failed (no lane is coming), or the evidence already came with its lane.
      if (last.status === "failing" || (last.lane !== null && last.lane !== undefined)) break;
    }
  }
  const statusSpec = findCommand("get_change_status");
  const status = statusSpec
    ? await callTool(ctx, r.target, statusSpec, { changeId: r.changeId })
    : {};
  const summary = shipSummary(status);
  const doc = withCommands(
    {
      ...summary,
      started: r.started,
      pushed: r.pushed !== null,
      pushedSha: r.head,
      git: r.wiring,
      waited: { seconds: waited, outcome, timeoutSec: wait ? timeoutSec : 0 },
      ...(r.started ? { idempotencyKey: r.key } : {}),
    },
    bundledCommands(),
  );
  ctx.out.result(doc, { text: shipText(summary, r.pushed) });
  return summary.lane !== null && summary.status !== "failing" ? EXIT.ok : EXIT.notReached;
}
