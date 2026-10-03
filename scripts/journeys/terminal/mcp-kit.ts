/** Helpers for the MCP captures: unwrap tool results, wait loops, git with a push grant. */
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlatformClient } from "../../../packages/mcp/src/client.js";
import type { Term } from "../lib/term.js";

type Success<R> = R extends { isError: true }
  ? never
  : R extends { structuredContent: infer T }
    ? T
    : never;

/** structuredContent of a tool call, or throw with the tool's error text (its fix included). */
export function ok<R extends { isError?: boolean; content: Array<{ type: string }> }>(
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

/** Pretty JSON with long strings shortened, for the screen. */
export function abridge(value: unknown, max = 150): string {
  return JSON.stringify(
    value,
    (_k, v: unknown) => (typeof v === "string" && v.length > max ? `${v.slice(0, max - 1)}…` : v),
    2,
  );
}

export type Until = "evidence_ready" | "lane_assigned" | "tour_ready" | "merged" | "reverted";

/** wait_for_change until reached, re-calling on "timeout" the way /start says; each call is shown. */
export async function waitFor(
  term: Term,
  mcp: PlatformClient,
  changeId: string,
  until: Until,
): Promise<void> {
  for (let i = 0; i < 40; i++) {
    term.typed(`wait_for_change({ changeId: "${changeId}", until: "${until}", timeoutSec: 50 })`);
    const r = await mcp.tools.wait_for_change(
      { changeId, until, timeoutSec: 50 },
      { timeout: 80_000 },
    );
    const w = ok("wait_for_change", r);
    term.print(
      abridge({
        reached: w.reached,
        reason: w.reason,
        status: w.change.status,
        lane: w.change.lane,
      }),
    );
    if (w.reached) return;
    if (w.reason === "unreachable")
      throw new Error(`${changeId} can't reach ${until}: ${w.change.status}`);
  }
  throw new Error(`${changeId}: ${until} not reached`);
}

export interface Grant {
  url: string;
  token: string;
  branch: string;
}

const workdirs = new Map<string, string>();

/** git clone / commit+push with the grant in the environment (never argv); shown with a placeholder. */
export function gitWithGrant(
  term: Term,
  grant: Grant,
  op: "clone" | "commit-push",
  changeId: string,
  message = "",
): string {
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Bearer ${grant.token}`,
  };
  const git = (cwd: string, args: string[]) => {
    const r = spawnSync("git", args, { cwd, env, encoding: "utf8" });
    const output = `${r.stdout ?? ""}${r.stderr ?? ""}`
      .replaceAll(grant.token, "«redacted»")
      .trim();
    if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${output}`);
    return output;
  };
  const short = grant.url.replace(/^https:\/\/[^/]+/, "https://…artifacts.cloudflare.net");
  if (op === "clone") {
    const base = mkdtempSync(join(tmpdir(), "gf-journey-"));
    const dir = join(base, "fork");
    term.typed(
      `git -c http.extraHeader="Authorization: Bearer $PUSH_TOKEN" clone ${short} fork && cd fork`,
    );
    git(base, ["clone", "--quiet", "--branch", grant.branch, grant.url, dir]);
    term.print(`Cloned into 'fork' (${git(dir, ["log", "--oneline", "-1"])})`);
    workdirs.set(changeId, dir);
    return dir;
  }
  const dir = workdirs.get(changeId);
  if (!dir) throw new Error(`no clone for ${changeId}`);
  term.typed(`git commit -am "${message}" && git push origin HEAD:${grant.branch}`);
  git(dir, ["add", "-A"]);
  git(dir, [
    "-c",
    "user.name=journey agent",
    "-c",
    "user.email=agent@gittifacts.dev",
    "commit",
    "--quiet",
    "-m",
    message,
  ]);
  git(dir, ["push", "--quiet", "origin", `HEAD:refs/heads/${grant.branch}`]);
  term.print(
    `[${grant.branch} ${git(dir, ["rev-parse", "--short", "HEAD"])}] ${message}\npushed to ${short}`,
  );
  return dir;
}
