/**
 * End to end: the bundled dist file (built fresh into a temp dir outside the repo, so it can't
 * resolve any node_modules) run as a child process against the real `createMcpServer` from
 * @app/mcp, served over HTTP with a fake McpBackend.
 */
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TOOL_DEFINITIONS } from "../src/tools/definitions.js";
import { tempDir } from "./support/io.js";
import { bearerFor, fakeBackend, hostOf, serveMcp } from "./support/mcp.js";

const root = join(import.meta.dirname, "..");
const work = tempDir("gittifacts-cli-e2e-");
const bundle = join(work, "bin", "cli.mjs");
const backend = fakeBackend();
let server: Awaited<ReturnType<typeof serveMcp>>;
let host: string;

interface Result {
  code: number | null;
  stdout: string;
  stderr: string;
}

function exec(
  cmd: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; stdin?: string },
): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(opts.stdin ?? "");
  });
}

function cli(
  args: string[],
  env: Record<string, string | undefined> = {},
  stdin?: string,
): Promise<Result> {
  const cwd = join(work, "project");
  mkdirSync(cwd, { recursive: true });
  return exec(process.execPath, [bundle, ...args], {
    cwd,
    stdin,
    env: {
      PATH: process.env.PATH,
      HOME: join(work, "home"),
      GITTIFACTS_CONFIG_DIR: join(work, "config"),
      GITTIFACTS_HOST: host,
      GITTIFACTS_TOKEN: bearerFor("ag_1"),
      ...env,
    },
  });
}

const json = (r: Result): Record<string, unknown> => JSON.parse(r.stdout);

beforeAll(async () => {
  const built = await exec(process.execPath, ["build.mjs", "--outfile", bundle], {
    cwd: root,
    env: process.env,
  });
  if (built.code !== 0) throw new Error(`build failed:\n${built.stderr}${built.stdout}`);
  server = await serveMcp(backend);
  host = hostOf(server.url);
}, 120_000);

afterAll(async () => {
  await server?.close();
});

describe("bundled CLI against the real MCP server", () => {
  it("offers a command for every tool the server lists", async () => {
    const r = await cli(["tools", "--remote"]);
    expect(r.code).toBe(0);
    const doc = json(r) as { tools: { command: string; inThisCli: boolean }[] };
    expect(doc.tools.map((t) => t.command).sort()).toEqual(
      TOOL_DEFINITIONS.map((t) => t.name.replaceAll("_", "-")).sort(),
    );
    expect(doc.tools.every((t) => t.inThisCli)).toBe(true);
  });

  it("calls a tool and prints its structured content, next steps as commands", async () => {
    const r = await cli(["get-change-status", "chg_1"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    const doc = json(r) as {
      change: { id: string; lane: number };
      nextSteps: { call?: string; command?: string }[];
      idempotencyKey?: string;
    };
    expect(doc.change).toMatchObject({ id: "chg_1", lane: 1, status: "awaiting-review" });
    expect(doc.nextSteps).toContainEqual({
      title: "Ask a human to review it",
      call: 'request_review({ changeId: "chg_1" })',
      command: "gittifacts request-review --change-id chg_1",
    });
    expect(doc.idempotencyKey).toBeUndefined();
  });

  it("renders --human tables and next steps", async () => {
    const r = await cli(["get-change-status", "--change-id", "chg_1", "--human"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^Get change status\n/);
    // A readable summary (src/views.ts), not the raw document.
    expect(r.stdout).toMatch(/Status: +awaiting-review \(waiting for a human review\)/);
    expect(r.stdout).toMatch(/Lane: +1 \(async glance\)/);
    expect(r.stdout).toMatch(/Steps\n\s+STEP\s+KIND\s+STATUS\s+LOG\n\s+test\s+user\s+✓ passed/);
    expect(r.stdout).toMatch(/Raised by\n\s+LANE\s+CODE\s+WHY\n\s+1\s+size\.lane1\s+medium diff/);
    expect(r.stdout).toMatch(
      /Next steps\n {2}1\. Read the tour a human will review\n {5}\$ gittifacts get-tour --change-id chg_1/,
    );
    expect(r.stdout.includes("\u001b[")).toBe(false);
  });

  it("passes the platform's error envelope through with exit 1", async () => {
    const r = await cli(["get-change-status", "nope"]);
    expect(r.code).toBe(1);
    expect(json(r)).toEqual({
      error: {
        code: "not-found",
        message: "change nope not found",
        fix: {
          explanation: "List what exists.",
          call: "list_repos({})",
          command: "gittifacts list-repos",
        },
      },
    });
  });

  it("sends an idempotency key on mutating calls and prints it", async () => {
    const args = [
      "create-plan",
      "--repo-id",
      "repo_1",
      "--title",
      "Rate limit logins",
      "--intent",
      "Stop credential stuffing on /login.",
      "--acceptance-criteria",
      "6th attempt gets 429",
    ];
    const given = await cli([...args, "--idempotency-key", "k-e2e"]);
    expect(given.code).toBe(0);
    expect(json(given)).toMatchObject({
      plan: { id: "plan_1", status: "draft" },
      idempotencyKey: "k-e2e",
    });
    expect(backend.calls).toContain("createPlan:k-e2e");

    const generated = json(await cli(args)) as { idempotencyKey: string };
    expect(generated.idempotencyKey).toMatch(/^cli_[\w-]{16}$/);
    expect(backend.calls).toContain(`createPlan:${generated.idempotencyKey}`);
  });

  it("reads arguments from stdin with -", async () => {
    const r = await cli(["get-change-status", "-"], {}, JSON.stringify({ changeId: "chg_1" }));
    expect(r.code).toBe(0);
    expect(json(r)).toMatchObject({ change: { id: "chg_1" } });
  });

  it("whoami reports the principal and where the token came from", async () => {
    const r = await cli(["whoami"]);
    expect(json(r)).toMatchObject({
      principalId: "ag_1",
      kind: "agent",
      auth: { host, hostSource: "env", tokenSource: "env" },
    });
  });

  it("without a token, the error says how to log in", async () => {
    const r = await cli(["whoami"], { GITTIFACTS_TOKEN: undefined });
    expect(r.code).toBe(1);
    expect(json(r)).toMatchObject({
      error: {
        code: "unauthorized",
        fix: {
          explanation: expect.stringContaining("Bearer"),
          command: `gittifacts login --host ${host}`,
        },
      },
    });
  });

  it("waits for a milestone with the wait command", async () => {
    const r = await cli(["wait", "chg_1", "--until", "merged", "--timeout", "30"]);
    expect(r.code).toBe(0);
    expect(json(r)).toMatchObject({
      reached: true,
      reason: "reached",
      change: { status: "merged" },
      waited: { attempts: 1 },
    });
  });

  it("init calls create_project with an idempotency key", async () => {
    const r = await cli(["init", "--template", "workers-api"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(json(r)).toMatchObject({ idempotencyKey: expect.stringMatching(/^cli_/) });
  });

  it("asks the server about commands it doesn't know, then gives up with suggestions", async () => {
    const r = await cli(["frobnicate-widgets", "chg_1"]);
    expect(r.code).toBe(2);
    expect(json(r)).toMatchObject({
      error: { code: "usage", message: "unknown command: frobnicate-widgets" },
    });
  });

  it("a network failure on a mutating call says how to retry with the same key", async () => {
    const r = await cli(["request-review", "chg_1", "--idempotency-key", "k-net"], {
      GITTIFACTS_HOST: "http://127.0.0.1:1",
    });
    expect(r.code).toBe(1);
    expect(json(r)).toMatchObject({
      error: {
        code: "network",
        fix: { command: "gittifacts request-review chg_1 --idempotency-key k-net" },
      },
      idempotencyKey: "k-net",
    });
  });
});
