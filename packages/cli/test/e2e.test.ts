/**
 * End to end: the bundled dist file (built fresh into a temp dir outside the repo, so it can't
 * resolve any node_modules) run as a child process against the real `createMcpServer` from
 * @app/mcp, served over HTTP with a fake McpBackend.
 */
import { spawn } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TOOL_DEFINITIONS } from "../src/tools/definitions.js";
import { journeyBackend } from "./support/git-journey.js";
import { type GitServer, serveGit } from "./support/git-server.js";
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
  cwd = join(work, "project"),
): Promise<Result> {
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
    expect(r.stdout).toMatch(/Lane: +Quick review \(Lane 1\)/);
    expect(r.stdout).toMatch(/Steps\n\s+STEP\s+KIND\s+STATUS\s+LOG\n\s+test\s+user\s+✓ passed/);
    expect(r.stdout).toMatch(/Raised by\n\s+LANE\s+CODE\s+WHY\n\s+1\s+size\.lane1\s+medium diff/);
    expect(r.stdout).toMatch(
      /Next steps\n {2}1\. Read the walkthrough a human will review\n {5}\$ gittifacts get-tour --change-id chg_1/,
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

describe("a checkout can't redirect the token (.gittifacts.json names the host)", () => {
  /** Another origin that records every request it gets (and serves nothing). */
  let attacker: Server;
  let evil: string;
  const seen: { url: string; authorization: string | null }[] = [];

  beforeAll(async () => {
    attacker = createServer((req, res) => {
      seen.push({ url: req.url ?? "", authorization: req.headers.authorization ?? null });
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => attacker.listen(0, "127.0.0.1", resolve));
    const addr = attacker.address();
    if (addr === null || typeof addr === "string") throw new Error("no port");
    evil = `http://127.0.0.1:${addr.port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => attacker.close(() => resolve()));
  });

  /** A checkout whose committed .gittifacts.json says `config`; returns its directory. */
  function checkout(name: string, config: Record<string, unknown>): string {
    const dir = join(work, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".gittifacts.json"), JSON.stringify({ projectId: "prj_x", ...config }));
    return dir;
  }

  it("refuses to send GITTIFACTS_TOKEN to a host only the project file names", async () => {
    const dir = checkout("hostile-host", { host: evil });
    const r = await cli(["whoami"], { GITTIFACTS_HOST: undefined }, undefined, dir);
    expect(r.code).toBe(1);
    expect(json(r)).toMatchObject({
      error: {
        code: "untrusted-host",
        message: expect.stringContaining(evil),
        fix: {
          explanation: expect.stringContaining("GITTIFACTS_TOKEN_HOST"),
          // Look at the file, never a command that sends the token there.
          command: expect.stringMatching(/^cat .*hostile-host\/\.gittifacts\.json$/),
        },
      },
    });
    expect(seen).toEqual([]);
  });

  it("ignores an mcpUrl that is not on the host, with a warning, and talks to the host", async () => {
    const dir = checkout("hostile-mcp", { host, mcpUrl: `${evil}/mcp` });
    const r = await cli(["whoami"], {}, undefined, dir);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(json(r)).toMatchObject({ principalId: "ag_1", auth: { host, tokenSource: "env" } });
    expect(r.stderr).toContain(`ignoring mcpUrl "${evil}/mcp"`);
    expect(seen).toEqual([]);
  });

  it("refuses plain http to anything but loopback, before sending anything", async () => {
    const dir = checkout("hostile-http", { host: "http://gittifacts.example" });
    const r = await cli(["whoami"], { GITTIFACTS_HOST: undefined }, undefined, dir);
    expect(json(r)).toMatchObject({ error: { code: "insecure-host" } });
    const flag = await cli(["whoami"], { GITTIFACTS_HOST: "http://gittifacts.example" });
    expect(json(flag)).toMatchObject({
      error: { code: "insecure-host", message: expect.stringContaining("GITTIFACTS_HOST") },
    });
  });

  it("still works for a host the user trusts: GITTIFACTS_TOKEN_HOST, or a login to that host", async () => {
    const dir = checkout("trusted", { host });
    const named = await cli(
      ["whoami"],
      { GITTIFACTS_HOST: undefined, GITTIFACTS_TOKEN_HOST: host },
      undefined,
      dir,
    );
    expect(json(named)).toMatchObject({
      principalId: "ag_1",
      auth: { host, hostSource: "project", tokenSource: "env" },
    });

    // A person who logged in to the host, then works in a repo `init` made: no env at all.
    const config = join(work, "config-logged-in");
    mkdirSync(config, { recursive: true });
    writeFileSync(
      join(config, "credentials.json"),
      JSON.stringify({
        version: 1,
        defaultHost: host,
        hosts: { [host]: { login: { token: bearerFor("hu_1"), tokenType: "Bearer" } } },
      }),
    );
    const env = { GITTIFACTS_HOST: undefined, GITTIFACTS_TOKEN: undefined };
    const loggedIn = await cli(
      ["whoami"],
      { ...env, GITTIFACTS_CONFIG_DIR: config },
      undefined,
      dir,
    );
    expect(json(loggedIn)).toMatchObject({
      principalId: "hu_1",
      auth: { host, hostSource: "project", tokenSource: "login" },
    });
    // …and an env token (an agent the person started) is fine there too.
    const agent = await cli(
      ["whoami"],
      { GITTIFACTS_HOST: undefined, GITTIFACTS_CONFIG_DIR: config },
      undefined,
      dir,
    );
    expect(json(agent)).toMatchObject({ principalId: "ag_1", auth: { tokenSource: "env" } });
    expect(seen).toEqual([]);
  });
});

/**
 * The quickstart past the green check, with real git over HTTP (support/git-server.ts): init
 * --clone, plain `git push` through the credential helper, ship (open Change, then a new one
 * after a merge), start-change repointing, clone through the read-only proxy, and TTY output.
 */
describe("git journey: plain git push, ship and clone against real git over HTTP", () => {
  const login = bearerFor("ag_1");
  const base = join(work, "journey");
  let git: GitServer;
  let journey: ReturnType<typeof journeyBackend>;
  let mcpServer: Awaited<ReturnType<typeof serveMcp>>;
  let env: NodeJS.ProcessEnv;

  const run = (args: string[], cwd: string, stdin?: string) =>
    exec(process.execPath, [bundle, ...args], { cwd, env, ...(stdin ? { stdin } : {}) });
  const gitIn = (cwd: string, ...args: string[]) => exec("git", args, { cwd, env });
  const headOf = async (cwd: string) => (await gitIn(cwd, "rev-parse", "HEAD")).stdout.trim();
  const commit = async (cwd: string, file: string, text: string) => {
    writeFileSync(join(cwd, file), text);
    expect((await gitIn(cwd, "add", file)).code).toBe(0);
    expect((await gitIn(cwd, "commit", "-q", "-m", `Edit ${file}`)).code).toBe(0);
  };
  const projectFile = (cwd: string) =>
    JSON.parse(readFileSync(join(cwd, ".gittifacts.json"), "utf8")) as Record<string, string>;

  beforeAll(async () => {
    mkdirSync(base, { recursive: true });
    env = {
      PATH: process.env.PATH,
      HOME: join(work, "journey-home"),
      GITTIFACTS_CONFIG_DIR: join(work, "journey-config"),
      GITTIFACTS_TOKEN: login,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "Ada",
      GIT_AUTHOR_EMAIL: "ada@example.com",
      GIT_COMMITTER_NAME: "Ada",
      GIT_COMMITTER_EMAIL: "ada@example.com",
    };
    mkdirSync(env.HOME as string, { recursive: true });
    git = await serveGit({
      root: join(work, "git"),
      mcpUrl: () => mcpServer.url,
      loginTokens: [login],
    });
    journey = journeyBackend(git, { projectToken: login });
    mcpServer = await serveMcp(journey.backend);
    env.GITTIFACTS_HOST = git.host;
    // main: a template's first commit (its .gitignore included).
    const seed = join(work, "seed");
    mkdirSync(seed);
    await gitIn(seed, "init", "-q", "-b", "main");
    writeFileSync(join(seed, "README.md"), "# app\n");
    copyFileSync(
      join(root, "..", "..", "templates", "workers-api", ".gitignore"),
      join(seed, ".gitignore"),
    );
    await gitIn(seed, "add", "-A");
    await gitIn(seed, "commit", "-q", "-m", "Initial commit from template workers-api");
    await gitIn(seed, "init", "-q", "--bare", "-b", "main", git.repo("main"));
    expect((await gitIn(seed, "push", "-q", git.repo("main"), "main")).code).toBe(0);
  }, 60_000);

  afterAll(async () => {
    await mcpServer?.close();
    await git?.close();
  });

  const clone = () => join(base, "app");

  it("init --clone wires the clone: plain git push reaches the Change's fork, no token on disk", async () => {
    const r = await run(["init", "--template", "workers-api", "--name", "app", "--clone"], base);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const doc = JSON.parse(r.stdout) as { git: { url: string; credentialHelper: string[] } };
    const fork = `${git.artifacts}/task-chg_9.git`;
    expect(doc.git).toMatchObject({ url: fork, credentialHelper: [new URL(git.artifacts).origin] });
    expect(projectFile(clone())).toMatchObject({
      projectId: "repo_1",
      changeId: "chg_9",
      remote: fork,
    });

    const config = readFileSync(join(clone(), ".git", "config"), "utf8");
    expect(config).toContain("git-credential");
    expect(config).toContain("push = HEAD:refs/heads/main");
    expect(config).not.toMatch(/tok\d|extraHeader|ag_1/);
    expect((await gitIn(clone(), "check-ignore", "-q", ".gittifacts.json")).code).toBe(0);

    await commit(clone(), "README.md", "# app\n\nFirst edit.\n");
    // The old behaviour: no credentials for the fork, so git push fails (401, no prompt).
    const origin = new URL(git.artifacts).origin;
    const bare = await gitIn(clone(), "-c", `credential.${origin}.helper=`, "push");
    expect(bare.code).not.toBe(0);
    expect(git.head("task-chg_9")).not.toBe(await headOf(clone()));

    const push = await gitIn(clone(), "push");
    expect(push.code, push.stderr).toBe(0);
    expect(git.head("task-chg_9")).toBe(await headOf(clone()));
    expect(git.log).toContain("artifacts POST /artifacts/task-chg_9.git/git-receive-pack basic:x");

    // As a person runs it later: no GITTIFACTS_* in the environment, only what init stored.
    await commit(clone(), "README.md", "# app\n\nSecond edit.\n");
    const plain = await exec("git", ["push"], {
      cwd: clone(),
      env: { ...env, GITTIFACTS_TOKEN: undefined, GITTIFACTS_HOST: undefined },
    });
    expect(plain.code, plain.stderr).toBe(0);
    expect(git.head("task-chg_9")).toBe(await headOf(clone()));
  });

  it("git credential fill gets a fresh push token without its ?expires= suffix", async () => {
    const host = new URL(git.artifacts).host;
    const r = await exec("git", ["credential", "fill"], {
      cwd: clone(),
      env,
      stdin: `protocol=http\nhost=${host}\n\n`,
    });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^protocol=http\nhost=.+\nusername=x\npassword=tok\d+\n/);
    expect(r.stdout).not.toContain("?expires=");
    // The helper itself also says when the token expires (git >= 2.41 keeps it).
    const own = await run(["git-credential", "get"], clone(), `protocol=http\nhost=${host}\n\n`);
    expect(own.stdout).toMatch(/^username=x\npassword=tok\d+\npassword_expiry_utc=\d+\n$/);
    // Any other origin gets no answer, so git falls through to its other helpers.
    const other = await run(
      ["git-credential", "get"],
      clone(),
      "protocol=https\nhost=example.com\n\n",
    );
    expect(other).toMatchObject({ code: 0, stdout: "" });
  });

  it("ship pushes HEAD to the open Change, waits for the lane and says what decided it", async () => {
    await commit(clone(), "src.txt", "feature\n");
    const r = await run(["ship"], clone());
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({
      changeId: "chg_9",
      started: false,
      pushed: true,
      pushedSha: await headOf(clone()),
      lane: 1,
      laneName: "Quick review (Lane 1)",
      reasons: [{ code: "size.lane1", lane: 1, message: "40 changed lines" }],
      checksPassed: 2,
      url: "https://gittifacts.test/changes/chg_9",
      nextStep: { command: "gittifacts request-review chg_9" },
    });
    expect(git.head("task-chg_9")).toBe(await headOf(clone()));
  });

  it("after a merge, ship starts a new Change and points origin (and plain git push) at its fork", async () => {
    journey.merge("chg_9");
    await commit(clone(), "src.txt", "second\n");
    const r = await run(["ship", "--title", "Second change", "--category", "fix"], clone());
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const fork = `${git.artifacts}/task-chg_10.git`;
    expect(JSON.parse(r.stdout)).toMatchObject({
      changeId: "chg_10",
      started: true,
      laneName: "Quick review (Lane 1)",
      git: { url: fork },
      idempotencyKey: expect.stringMatching(/^cli_/),
    });
    expect(journey.changes.get("chg_10")?.title).toBe("Second change");
    expect((await gitIn(clone(), "remote", "get-url", "origin")).stdout.trim()).toBe(fork);
    expect(projectFile(clone()).changeId).toBe("chg_10");
    await commit(clone(), "src.txt", "third\n");
    expect((await gitIn(clone(), "push")).code).toBe(0);
    expect(git.head("task-chg_10")).toBe(await headOf(clone()));
  });

  it("start-change inside the clone repoints origin; its JSON keeps the remote", async () => {
    const r = await run(
      ["start-change", "--repo-id", "repo_1", "--title", "Third", "--category", "chore"],
      clone(),
    );
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const doc = JSON.parse(r.stdout) as { remote: { token: string }; git: { url: string } };
    expect(doc.remote.token).toMatch(/^tok\d+\?expires=/);
    expect(doc.git.url).toBe(`${git.artifacts}/task-chg_11.git`);
    expect(projectFile(clone()).changeId).toBe("chg_11");
    expect((await gitIn(clone(), "push")).code).toBe(0);
    expect(git.head("task-chg_11")).toBe(await headOf(clone()));
  });

  it("clone <repoId> clones through the read-only proxy with the login token, then ships", async () => {
    const unknown = await run(["clone", "repo_1"], base);
    expect(unknown.code).toBe(1);
    expect(JSON.parse(unknown.stdout)).toMatchObject({
      error: { code: "no-clone-url", fix: { command: expect.stringContaining("--url") } },
    });

    const url = `${git.host}/git/acme/app.git`;
    const r = await run(["clone", "repo_1", "--url", url, "--dir", "copy"], base);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const dir = join(base, "copy");
    expect(JSON.parse(r.stdout)).toMatchObject({
      repoId: "repo_1",
      clonedTo: realpathSync(dir),
      cloneUrl: url,
    });
    expect(projectFile(dir)).toMatchObject({ projectId: "repo_1", cloneUrl: url });
    expect(readFileSync(join(dir, ".git", "config"), "utf8")).not.toContain("ag_1");
    // Fetching asks the helper, which answers the platform host with the login token.
    const fetched = await gitIn(dir, "fetch", "-q");
    expect(fetched.code, fetched.stderr).toBe(0);
    expect(git.log).toContain("proxy GET /git/acme/app.git/info/refs basic:x-access-token");
    // The proxy is read-only; ship starts a Change and pushes to its fork instead.
    expect((await gitIn(dir, "push")).code).not.toBe(0);
    await commit(dir, "copy.txt", "from the clone\n");
    const shipped = await run(["ship"], dir);
    expect(shipped.code, shipped.stdout + shipped.stderr).toBe(0);
    const doc = JSON.parse(shipped.stdout) as { changeId: string; started: boolean };
    expect(doc.started).toBe(true);
    expect(git.head(`task-${doc.changeId}`)).toBe(await headOf(dir));
  });

  // A pseudo-terminal: BSD script (macOS) and util-linux script (Linux) differ, and both need a
  // real file (not a socket) on stdin. The output keeps the terminal's \r\n and a ^D echo.
  const onTty = (args: string[], cwd: string): Promise<Result> =>
    new Promise((resolve, reject) => {
      const argv = [process.execPath, bundle, ...args];
      const child = spawn(
        "script",
        process.platform === "darwin"
          ? ["-q", "/dev/null", ...argv]
          : ["-qec", argv.map((a) => `'${a}'`).join(" "), "/dev/null"],
        { cwd, env, stdio: [openSync("/dev/null", "r"), "pipe", "pipe"] },
      );
      let stdout = "";
      child.stdout?.on("data", (d: Buffer) => {
        stdout += d.toString();
      });
      child.on("error", reject);
      child.on("close", (code) =>
        resolve({ code, stdout: stdout.replaceAll("\r", "").replace(/^\^D[\b]*/, ""), stderr: "" }),
      );
    });

  it.runIf(process.platform === "darwin" || process.platform === "linux")(
    "on a terminal: text help, and init in at most six lines; piped: the same JSON as before",
    async () => {
      const help = await onTty(["help"], base);
      expect(help.code).toBe(0);
      expect(help.stdout).toMatch(/Usage: gittifacts <command>/);
      expect(help.stdout.trimStart().startsWith("{")).toBe(false);

      const dir = join(base, "tty");
      mkdirSync(dir);
      const init = await onTty(["init", "--template", "workers-api", "--name", "tty"], dir);
      expect(init.code, init.stdout).toBe(0);
      const lines = init.stdout.trim().split("\n");
      expect(lines.length).toBeLessThanOrEqual(6);
      expect(lines[0]).toMatch(/^Created repo tty \(repo_1\)/);
      expect(init.stdout).toContain("Claim it to keep it");
      expect(init.stdout).toContain("https://p-repo-1.preview.test");

      await commit(clone(), "tty.txt", "on a terminal\n");
      const shipped = await onTty(["ship"], clone());
      expect(shipped.code, shipped.stdout).toBe(0);
      expect(shipped.stdout).toMatch(/^Shipped chg_\d+: pushed [0-9a-f]{12}\n/m);
      expect(shipped.stdout).toMatch(
        /Lane: Quick review \(Lane 1\)\n {2}- 40 changed lines \(size\.lane1\)\n {2}2 checks passed\n/,
      );
      expect(shipped.stdout).toMatch(
        /Next: Ask a person to review it\n {2}\$ gittifacts request-review chg_\d+/,
      );

      const piped = await run(["help"], base);
      expect(JSON.parse(piped.stdout)).toMatchObject({
        name: "gittifacts",
        usage: expect.any(String),
      });
      const forced = await onTty(["help", "--json"], base);
      expect(JSON.parse(forced.stdout.slice(forced.stdout.indexOf("{")))).toMatchObject({
        name: "gittifacts",
      });
    },
  );
});
