/** Shared bits of the terminal captures: arguments, the host, the CLI tarball, state.json. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

export const HOST = (process.env.GF_HOST ?? "https://gittifacts.decroockjovi.workers.dev").replace(
  /\/+$/,
  "",
);
/** The CLI as the platform serves it (not on npm yet). */
export const CLI = `${HOST}/cli/gittifacts.tgz`;

export function terminalArgs(): {
  out: string;
  state: string;
  agentFile?: string;
  values: Record<string, string | boolean | undefined>;
} {
  const { values } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: "string" },
      state: { type: "string" },
      "agent-file": { type: "string" },
      repo: { type: "string" },
    },
  });
  if (!values.out) {
    console.error("pass --out <dir> (and --state <state.json>)");
    process.exit(2);
  }
  const out = resolve(values.out);
  return {
    out,
    state: resolve(values.state ?? `${out}/state.json`),
    ...(values["agent-file"] ? { agentFile: resolve(values["agent-file"]) } : {}),
    values,
  };
}

/** The first JSON document in a command's stdout, or null. */
export function parseJson<T>(stdout: string): T | null {
  const start = stdout.indexOf("{");
  if (start < 0) return null;
  try {
    return JSON.parse(stdout.slice(start)) as T;
  } catch {
    return null;
  }
}

export function readState(path: string): Record<string, unknown> {
  return existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>)
    : {};
}

export function mergeState(path: string, patch: Record<string, unknown>): void {
  const next = { ...readState(path) };
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) next[k] = v;
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
}

/** An agent token from a `{ token }` JSON file (never printed). */
export function agentToken(file: string | undefined): string {
  const path = file ?? process.env.GF_AGENT_FILE;
  if (path === undefined) throw new Error("pass --agent-file <agent.json> (a { token } file)");
  const token = (JSON.parse(readFileSync(path, "utf8")) as { token?: unknown }).token;
  if (typeof token !== "string") throw new Error(`${path} has no token`);
  return token;
}
