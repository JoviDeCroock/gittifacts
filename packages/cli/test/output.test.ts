import { describe, expect, it } from "vitest";
import {
  callToCommand,
  commandForCall,
  parseCall,
  shellQuote,
  withCommands,
} from "../src/calls.js";
import { makeStyle, renderError, renderHuman, useColor } from "../src/human.js";
import { harness, run } from "./support/io.js";

const plain = { style: makeStyle(false), width: 100 };

describe("JSON output (default)", () => {
  it("prints exactly one JSON document on stdout", async () => {
    const h = harness();
    const r = await run(h, ["tools"]);
    expect(r.code).toBe(0);
    const doc = r.json() as { tools: { command: string }[] };
    expect(doc.tools.map((t) => t.command)).toContain("get-change-status");
    expect(r.stderr).toBe("");
    h.cleanup();
  });

  it("prints errors as { error: { code, message, fix } } on stdout with a non-zero exit", async () => {
    const h = harness();
    const r = await run(h, ["get-change-status", "chg_1"]);
    expect(r.code).toBe(1);
    expect(r.json()).toEqual({
      error: {
        code: "no-host",
        message: "no platform host configured",
        fix: {
          explanation: expect.stringContaining("--host"),
          command: "gittifacts login --host https://<host>",
        },
      },
    });
    const usage = await run(h, ["get-change-stats"]);
    expect(usage.code).toBe(2);
    expect(usage.json()).toMatchObject({
      error: {
        code: "usage",
        message: expect.stringContaining("did you mean get-change-status"),
        fix: { command: "gittifacts get-change-status --help" },
      },
    });
    h.cleanup();
  });

  it("documents commands, global flags and exit codes in `help`", async () => {
    const h = harness();
    const doc = (await run(h, [])).json() as {
      commands: { command: string; source: string }[];
      exitCodes: Record<string, string>;
    };
    expect(doc.commands.filter((c) => c.source === "builtin").map((c) => c.command)).toEqual([
      "init",
      "login",
      "logout",
      "wait",
      "tools",
      "search-tools",
      "help",
    ]);
    expect(Object.keys(doc.exitCodes)).toEqual(["0", "1", "2", "3", "130"]);
    const one = (await run(h, ["create-plan", "--help"])).json() as {
      usage: string;
      mutating: boolean;
    };
    expect(one.usage).toMatch(/^gittifacts create-plan --repo-id <string>/);
    expect(one.mutating).toBe(true);
    h.cleanup();
  });

  it("prints the version", async () => {
    const h = harness();
    expect((await run(h, ["--version"])).json()).toEqual({
      name: "gittifacts",
      version: expect.any(String),
    });
    h.cleanup();
  });
});

describe("--human output", () => {
  const doc = {
    change: {
      id: "chg_1",
      status: "awaiting-review",
      lane: 1,
      laneReasons: [{ code: "size.lane1", lane: 1, message: "medium diff" }],
    },
    runs: [],
    nextSteps: [
      {
        title: "Ask a human to review it",
        call: 'request_review({ changeId: "chg_1" })',
        command: "gittifacts request-review --change-id chg_1",
      },
    ],
  };

  it("renders sections, tables and next steps as plain text", () => {
    const text = renderHuman(doc, { ...plain, title: "Get change status" });
    expect(text).toBe(
      [
        "Get change status",
        "",
        "Change",
        "  Id:     chg_1",
        "  Status: awaiting-review",
        "  Lane:   1",
        "",
        "  Lane reasons",
        "    CODE        LANE  MESSAGE",
        "    size.lane1  1     medium diff",
        "",
        "Runs",
        "  (none)",
        "",
        "Next steps",
        "  1. Ask a human to review it",
        "     $ gittifacts request-review --change-id chg_1",
        '     mcp: request_review({ changeId: "chg_1" })',
        "",
      ].join("\n"),
    );
    expect(text.includes("\u001b[")).toBe(false);
  });

  it("highlights the fix of an error, with color only when enabled", () => {
    const body = {
      code: "not-found",
      message: "change nope not found",
      fix: {
        explanation: "List what exists.",
        call: "list_repos({})",
        command: "gittifacts list-repos",
      },
    };
    expect(renderError(body, plain, { idempotencyKey: "k1" })).toBe(
      [
        "Error [not-found] change nope not found",
        "",
        "Fix: List what exists.",
        "  $ gittifacts list-repos",
        "  mcp: list_repos({})",
        "",
        "Idempotency key: k1",
        "",
      ].join("\n"),
    );
    const colored = renderError(body, { style: makeStyle(true), width: 100 });
    expect(colored.includes("\u001b[33m")).toBe(true);
  });

  it("uses color only on a TTY and never with NO_COLOR", () => {
    expect(useColor({ isTTY: false }, {})).toBe(false);
    expect(useColor({ isTTY: true }, {})).toBe(true);
    expect(useColor({ isTTY: true }, { NO_COLOR: "1" })).toBe(false);
    expect(useColor({ isTTY: true }, { TERM: "dumb" })).toBe(false);
    expect(useColor({ isTTY: false }, { FORCE_COLOR: "1" })).toBe(true);
  });

  it("sends human errors to stderr and keeps stdout empty", async () => {
    const h = harness({ tty: false });
    const r = await run(h, ["get-change-status", "chg_1", "--human"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/^Error \[no-host\]/);
    expect(r.stderr).toMatch(/Fix: Tell the CLI which platform to use/);
    expect(r.stderr.includes("\u001b[")).toBe(false);
    h.cleanup();
  });

  it("shrinks wide tables to the terminal width", () => {
    const text = renderHuman(
      { items: [{ id: "a", note: "x".repeat(300) }] },
      { style: makeStyle(false), width: 60 },
    );
    for (const line of text.split("\n")) expect(line.length).toBeLessThanOrEqual(60);
    expect(text).toMatch(/…/);
  });
});

describe("MCP calls as CLI commands", () => {
  it("parses the conventions' call notation", () => {
    expect(
      parseCall(
        'start_change({ repoId: "r_1", planId: "p_1", title: "Fix \\"x\\"", category: "fix" })',
      ),
    ).toEqual({
      tool: "start_change",
      args: { repoId: "r_1", planId: "p_1", title: 'Fix "x"', category: "fix" },
    });
    expect(parseCall("whoami({})")).toEqual({ tool: "whoami", args: {} });
    expect(parseCall("whoami()")).toEqual({ tool: "whoami", args: {} });
    expect(parseCall("not a call")).toBeNull();
  });

  it("maps calls to commands, with friendlier local commands where they exist", () => {
    expect(commandForCall('get_change_status({ changeId: "chg_1" })')).toBe(
      "gittifacts get-change-status --change-id chg_1",
    );
    expect(
      commandForCall('wait_for_change({ changeId: "chg_1", until: "merged", timeoutSec: 600 })'),
    ).toBe("gittifacts wait chg_1 --timeout 600 --until merged");
    expect(commandForCall('create_project({ template: "workers-api", name: "my-api" })')).toBe(
      "gittifacts init --template workers-api --name my-api",
    );
    expect(
      commandForCall(
        'create_plan({ repoId: "<projectId>", title: "<what>", acceptanceCriteria: ["a b", "c"], scopePaths: ["src/**"] })',
      ),
    ).toBe(
      "gittifacts create-plan --repo-id '<projectId>' --title '<what>' --acceptance-criteria 'a b' --acceptance-criteria c --scope-paths 'src/**'",
    );
    expect(callToCommand({ tool: "open_workspace", args: { changeId: "c", warm: true } })).toBe(
      "gittifacts open-workspace --change-id c --warm true",
    );
  });

  it("adds `command` next to every next step and fix that has a `call`", () => {
    const out = withCommands({
      nextSteps: [
        { title: "Look", call: 'get_tour({ changeId: "c" })' },
        { title: "Just read", why: "no call" },
      ],
      error: { code: "x", message: "y", fix: { explanation: "z", call: "whoami({})" } },
      unrelated: { call: "whoami({})" },
    });
    expect(out.nextSteps[0]).toEqual({
      title: "Look",
      call: 'get_tour({ changeId: "c" })',
      command: "gittifacts get-tour --change-id c",
    });
    expect(out.nextSteps[1]).toEqual({ title: "Just read", why: "no call" });
    expect((out.error.fix as { command?: string }).command).toBe("gittifacts whoami");
    expect(out.unrelated).toEqual({ call: "whoami({})" });
  });

  it("quotes for POSIX shells", () => {
    expect(shellQuote("chg_1")).toBe("chg_1");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    expect(shellQuote("")).toBe("''");
    expect(shellQuote("a;rm -rf /")).toBe("'a;rm -rf /'");
  });
});
