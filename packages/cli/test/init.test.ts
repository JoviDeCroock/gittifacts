import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { commandForCall } from "../src/calls.js";
import { EXIT } from "../src/errors.js";
import { gitAuthEnv, splitRemote } from "../src/git.js";
import { type GitRunner, runGit } from "../src/io.js";
import { harness, run, tempDir } from "./support/io.js";
import { mockConnector } from "./support/mcp.js";

const HOST = "https://gittifacts.example";

/** What create_project returns (onboarding §3); the platform is still adding the tool. */
type ProjectOut = Record<string, unknown>;

function created(over: ProjectOut = {}): ProjectOut {
  return {
    projectId: "prj_1",
    remote: "https://git.gittifacts.example/prj_1.git",
    token: "tok_secret",
    mcpUrl: `${HOST}/mcp`,
    previewUrl: "https://prj-1.preview.example",
    claimUrl: `${HOST}/claim/abc`,
    nextSteps: [
      {
        title: "Wait for the first green",
        call: 'wait_for_change({ changeId: "chg_1", until: "evidence_ready", timeoutSec: 120 })',
      },
    ],
    ...over,
  };
}

const createProjectSchema = {
  name: "create_project",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string" },
      template: { type: "string" },
      idempotencyKey: { type: "string" },
    },
  },
};

function initHarness(
  result: ProjectOut = created(),
  opts: {
    git?: GitRunner;
    declareKey?: boolean;
    env?: Record<string, string>;
    untyped?: Record<string, (args: Record<string, unknown>) => unknown>;
  } = {},
) {
  const calls: Record<string, unknown>[] = [];
  const h = harness({
    env: { GITTIFACTS_HOST: HOST, ...opts.env },
    ...(opts.git ? { git: opts.git } : {}),
  });
  const connector = mockConnector(
    {
      tools: {
        whoami: {
          principalId: "anon_prj_1",
          kind: "agent",
          name: "unclaimed",
          ownerId: null,
          ownerName: null,
          agentsUrl: `${HOST}/agents`,
          nextSteps: [],
          scopes: ["repo:read"],
          canApprove: false,
          repos: [],
          quotas: {
            enforced: true,
            ciMinutesPerDay: 30,
            ciMinutesUsedToday: 0,
            artifactsOpsPerDay: 100,
          },
        },
      },
    },
    {
      untyped: {
        create_project: (args) => {
          calls.push({ ...args });
          return result;
        },
        ...opts.untyped,
      },
      ...(opts.declareKey ? { listTools: async () => [createProjectSchema] } : {}),
    },
  );
  h.io.connect = connector;
  return { h, calls, connector };
}

describe("gittifacts init", () => {
  it("calls create_project without credentials, writes .gittifacts.json and stores the token 0600", async () => {
    const { h, calls, connector } = initHarness();
    const r = await run(h, ["init", "--template", "workers-api", "--name", "my-api"]);
    expect(r.code).toBe(EXIT.ok);
    expect(calls).toEqual([{ template: "workers-api", name: "my-api" }]);
    expect(connector.connections[0]).toEqual({
      token: null,
      headers: { "Idempotency-Key": "cli_id1" },
    });

    expect(JSON.parse(readFileSync(join(h.dir, ".gittifacts.json"), "utf8"))).toEqual({
      host: HOST,
      projectId: "prj_1",
      remote: "https://git.gittifacts.example/prj_1.git",
      mcpUrl: `${HOST}/mcp`,
    });
    const credsPath = join(h.dir, "config", "credentials.json");
    expect(statSync(credsPath).mode & 0o777).toBe(0o600);
    const creds = JSON.parse(readFileSync(credsPath, "utf8"));
    expect(creds.hosts[HOST].projects.prj_1).toMatchObject({
      token: "tok_secret",
      claimUrl: `${HOST}/claim/abc`,
    });

    const doc = r.json() as Record<string, unknown> & { nextSteps: { command?: string }[] };
    expect(doc).toMatchObject({
      projectId: "prj_1",
      previewUrl: "https://prj-1.preview.example",
      claimUrl: `${HOST}/claim/abc`,
      tokenStored: true,
      config: join(h.dir, ".gittifacts.json"),
      idempotencyKey: "cli_id1",
    });
    expect(doc.token).toBeUndefined();
    expect(r.stdout).not.toContain("tok_secret");
    expect(doc.nextSteps[0]?.command).toBe(
      "gittifacts wait chg_1 --timeout 120 --until evidence_ready",
    );
    h.cleanup();
  });

  it("drops the platform's reconnect step: the CLI stored the token, so the bootstrap wait is nextSteps[0]", async () => {
    const reconnect = {
      title: `Reconnect to ${HOST}/mcp with Authorization: Bearer <token>`,
      call: "whoami({})",
      why: "Reconnect with `Authorization: Bearer <token>`.",
    };
    const base = created();
    const { h } = initHarness({
      ...base,
      nextSteps: [reconnect, ...(base.nextSteps as unknown[])],
    });
    const r = await run(h, ["init", "--template", "workers-api"]);
    expect(r.code).toBe(EXIT.ok);
    const doc = r.json() as { nextSteps: { title: string; command?: string }[] };
    expect(doc.nextSteps.map((s) => s.title)).toEqual(["Wait for the first green"]);
    expect(doc.nextSteps[0]?.command).toMatch(/^gittifacts wait chg_1 /);
    h.cleanup();
  });

  it("then uses the project's token inside the project", async () => {
    const { h, connector } = initHarness();
    await run(h, ["init", "--template", "workers-api"]);
    const r = await run(h, ["whoami"]);
    expect(r.code).toBe(EXIT.ok);
    expect(connector.connections[1]?.token).toBe("tok_secret");
    expect(r.json()).toMatchObject({
      principalId: "anon_prj_1",
      auth: { host: HOST, hostSource: "env", tokenSource: "project" },
    });
    h.cleanup();
  });

  it("sends the idempotency key as an argument when the tool declares one, and --show-token prints it", async () => {
    const { h, calls } = initHarness(created(), { declareKey: true });
    const r = await run(h, [
      "init",
      "--template",
      "ts-library",
      "--idempotency-key",
      "retry-1",
      "--show-token",
    ]);
    expect(calls).toEqual([{ template: "ts-library", idempotencyKey: "retry-1" }]);
    expect(r.json()).toMatchObject({ token: "tok_secret", idempotencyKey: "retry-1" });
    h.cleanup();
  });

  it("explains when the platform has no create_project yet", async () => {
    const h = harness({ env: { GITTIFACTS_HOST: HOST } });
    h.io.connect = mockConnector({ tools: {} });
    const r = await run(h, ["init"]);
    expect(r.code).toBe(EXIT.error);
    expect(r.json()).toEqual({
      error: {
        code: "unknown-tool",
        message: `${HOST} has no MCP tool named create_project`,
        fix: {
          explanation: expect.stringContaining("create_project"),
          command: "gittifacts tools --remote",
        },
      },
      idempotencyKey: "cli_id1",
    });
    expect(existsSync(join(h.dir, ".gittifacts.json"))).toBe(false);
    h.cleanup();
  });

  it("refuses to overwrite an existing project file and conflicting flags, before calling anything", async () => {
    const { h, calls } = initHarness();
    writeFileSync(
      join(h.dir, ".gittifacts.json"),
      JSON.stringify({ host: HOST, projectId: "old" }),
    );
    const r = await run(h, ["init"]);
    expect(r.json()).toMatchObject({ error: { code: "already-initialized" } });
    const both = await run(h, [
      "init",
      "--template",
      "static-site",
      "--from",
      "https://github.com/a/b",
    ]);
    expect(both.code).toBe(EXIT.usage);
    const badTemplate = await run(h, ["init", "--template", "rails"]);
    expect(badTemplate.code).toBe(EXIT.usage);
    expect(calls).toHaveLength(0);
    const forced = await run(h, ["init", "--force", "--from", "https://github.com/a/b"]);
    expect(forced.code).toBe(EXIT.ok);
    expect(calls).toEqual([{ from: "https://github.com/a/b" }]);
    h.cleanup();
  });

  it("--clone passes the token through git's environment, never argv", async () => {
    const gitCalls: { args: readonly string[]; env: Record<string, string> }[] = [];
    const git: GitRunner = async (args, opts) => {
      gitCalls.push({ args, env: opts.env });
      mkdirSync(String(args.at(-1)), { recursive: true });
      return { code: 0, stdout: "", stderr: "" };
    };
    const remote = { url: "https://git.gittifacts.example/prj_1.git", token: "art_tok?expires=1" };
    const { h } = initHarness(created({ remote }), { git });
    const r = await run(h, ["init", "--template", "workers-api", "--name", "My API", "--clone"]);
    expect(r.code).toBe(EXIT.ok);
    const dir = join(h.dir, "my-api");
    expect(gitCalls).toEqual([
      {
        args: ["clone", "--", "https://git.gittifacts.example/prj_1.git", dir],
        env: {
          GIT_TERMINAL_PROMPT: "0",
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "http.extraHeader",
          GIT_CONFIG_VALUE_0: "Authorization: Bearer art_tok?expires=1",
        },
      },
    ]);
    expect(JSON.stringify(gitCalls[0]?.args)).not.toContain("art_tok");
    expect(existsSync(join(dir, ".gittifacts.json"))).toBe(true);
    expect(r.json()).toMatchObject({ clonedTo: dir });
    h.cleanup();
  });

  describe("--clone when the platform returns no git token", () => {
    const fork = "https://git.gittifacts.example/prj_1.git";
    const recordingGit = (code = 0) => {
      const calls: { args: readonly string[]; env: Record<string, string> }[] = [];
      const git: GitRunner = async (args, opts) => {
        calls.push({ args, env: opts.env });
        if (code === 0) mkdirSync(String(args.at(-1)), { recursive: true });
        return { code, stdout: "", stderr: code === 0 ? "" : "fatal: Authentication failed" };
      };
      return { git, calls };
    };
    const auth = (env: Record<string, string> | undefined) => env?.GIT_CONFIG_VALUE_0 ?? null;

    it("never sends the platform token (project's or login) to another origin: it asks refresh_push_token", async () => {
      const { git, calls: gitCalls } = recordingGit();
      const refreshed: Record<string, unknown>[] = [];
      const { h, connector } = initHarness(
        created({ remote: { url: fork, branch: "main", changeId: "chg_1" } }),
        {
          git,
          env: { GITTIFACTS_TOKEN: "login_tok" },
          untyped: {
            refresh_push_token: (args) => {
              refreshed.push(args);
              return { remote: { url: fork, token: "push_tok", branch: "main" } };
            },
          },
        },
      );
      const r = await run(h, ["init", "--template", "workers-api", "--clone", "--dir", "app"]);
      expect(r.code).toBe(EXIT.ok);
      expect(refreshed).toEqual([{ changeId: "chg_1" }]);
      // The refresh is asked of the platform (MCP), with the project's own token.
      expect(connector.connections[1]?.token).toBe("tok_secret");
      expect(auth(gitCalls[0]?.env)).toBe("Authorization: Bearer push_tok");
      expect(JSON.stringify(gitCalls)).not.toMatch(/tok_secret|login_tok/);
      h.cleanup();
    });

    it("clones without auth and names the call when no push token is available", async () => {
      const { git, calls: gitCalls } = recordingGit(128);
      const { h } = initHarness(
        created({ token: null, remote: { url: fork, changeId: "chg_1" } }),
        { git, env: { GITTIFACTS_TOKEN: "login_tok" } },
      );
      const r = await run(h, ["init", "--template", "workers-api", "--clone", "--dir", "app"]);
      expect(r.code).toBe(EXIT.error);
      expect(gitCalls).toHaveLength(1);
      expect(auth(gitCalls[0]?.env)).toBeNull();
      expect(JSON.stringify(gitCalls)).not.toContain("login_tok");
      const fix = (
        r.json() as { error: { code: string; fix: { call?: string; command?: string } } }
      ).error;
      expect(fix.code).toBe("clone-failed");
      expect(fix.fix.call).toBe('refresh_push_token({ changeId: "chg_1" })');
      expect(fix.fix.command).toBe(commandForCall('refresh_push_token({ changeId: "chg_1" })'));
      h.cleanup();
    });

    it("sends the platform token to a remote on the platform's own origin", async () => {
      const { git, calls: gitCalls } = recordingGit();
      const { h } = initHarness(created({ remote: `${HOST}/git/prj_1.git` }), { git });
      const r = await run(h, ["init", "--template", "workers-api", "--clone", "--dir", "app"]);
      expect(r.code).toBe(EXIT.ok);
      expect(auth(gitCalls[0]?.env)).toBe("Authorization: Bearer tok_secret");
      h.cleanup();
    });
  });

  it("moves credentials out of a remote URL before cloning", () => {
    expect(splitRemote("https://x:s3cret@git.example/r.git")).toEqual({
      url: "https://git.example/r.git",
      auth: { scheme: "Basic", username: "x", password: "s3cret" },
    });
    expect(splitRemote("https://git.example/r.git")).toEqual({
      url: "https://git.example/r.git",
      auth: null,
    });
    expect(
      gitAuthEnv({ scheme: "Basic", username: "x", password: "s3cret" }).GIT_CONFIG_VALUE_0,
    ).toBe(`Authorization: Basic ${Buffer.from("x:s3cret").toString("base64")}`);
  });

  it("a real git clone never writes the token to .git/config", async () => {
    const work = tempDir();
    const git = (args: string[], cwd: string) =>
      runGit(args, { cwd, env: { GIT_CONFIG_NOSYSTEM: "1" } });
    const id = ["-c", "user.name=t", "-c", "user.email=t@example.com"];
    await git(["init", "--bare", "-b", "main", "origin.git"], work);
    await git(["init", "-b", "main", "seed"], work);
    writeFileSync(join(work, "seed", "README.md"), "hi\n");
    await git(["add", "."], join(work, "seed"));
    expect((await git([...id, "commit", "-m", "seed"], join(work, "seed"))).code).toBe(0);
    expect((await git(["push", join(work, "origin.git"), "main"], join(work, "seed"))).code).toBe(
      0,
    );

    const { h } = initHarness(created({ remote: join(work, "origin.git") }), { git: runGit });
    const r = await run(h, ["init", "--template", "static-site", "--clone", "--dir", "site"]);
    expect(r.code).toBe(EXIT.ok);
    const config = readFileSync(join(h.dir, "site", ".git", "config"), "utf8");
    expect(config).not.toContain("tok_secret");
    expect(config).not.toMatch(/extraHeader/i);
    expect(readFileSync(join(h.dir, "site", "README.md"), "utf8")).toBe("hi\n");
    expect(
      JSON.parse(readFileSync(join(h.dir, "site", ".gittifacts.json"), "utf8")).projectId,
    ).toBe("prj_1");
    h.cleanup();
  });
});
