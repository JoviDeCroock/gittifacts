import { describe, expect, it } from "vitest";
import {
  buildToolArgs,
  type Globals,
  parseCommandTokens,
  splitArgv,
} from "../src/args.js";
import { CliError, EXIT } from "../src/errors.js";
import { deriveCommand, findCommand } from "../src/tools/commands.js";

const spec = (name: string) => {
  const c = findCommand(name);
  if (!c) throw new Error(name);
  return c;
};

function parse(command: string, argv: string[], stdin: string | null = null) {
  const inv = splitArgv([command, ...argv]);
  const s = spec(command);
  const parsed = parseCommandTokens(s, inv.tokens, inv.globals);
  return { args: buildToolArgs(s, parsed, inv.globals, stdin), globals: inv.globals, parsed };
}

function usageErrorOf(fn: () => unknown): CliError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(CliError);
    const err = e as CliError;
    expect(err.exitCode).toBe(EXIT.usage);
    expect(err.body.code).toBe("usage");
    expect(err.body.fix.explanation.length).toBeGreaterThan(0);
    return err;
  }
  throw new Error("expected a usage error");
}

describe("global flags", () => {
  it("are read before and after the command", () => {
    const inv = splitArgv(["--host", "https://x.example", "--human", "whoami", "--idempotency-key=k1"]);
    expect(inv.command).toBe("whoami");
    expect(inv.globals).toMatchObject({ host: "https://x.example", human: true });
    const g: Globals = inv.globals;
    parseCommandTokens(spec("whoami"), inv.tokens, g);
    expect(g.idempotencyKey).toBe("k1");
  });

  it("refuse command flags before the command", () => {
    const err = usageErrorOf(() => splitArgv(["--change-id", "x", "get-change-status"]));
    expect(err.body.message).toMatch(/before the command/);
  });

  it("no command means help; --version is a global", () => {
    expect(splitArgv([]).command).toBeNull();
    expect(splitArgv(["--version"]).globals.version).toBe(true);
    expect(splitArgv(["-h"]).globals.help).toBe(true);
  });
});

describe("command flags", () => {
  it("parse --flag value, --flag=value, camelCase and a positional", () => {
    expect(parse("get-change-status", ["--change-id", "chg_1"]).args).toEqual({ changeId: "chg_1" });
    expect(parse("get-change-status", ["--change-id=chg_2"]).args).toEqual({ changeId: "chg_2" });
    expect(parse("get-change-status", ["--changeId", "chg_3"]).args).toEqual({ changeId: "chg_3" });
    expect(parse("get-change-status", ["chg_4"]).args).toEqual({ changeId: "chg_4" });
  });

  it("coerce integers and enums, and reject bad values", () => {
    expect(
      parse("wait-for-change", ["chg_1", "--until", "merged", "--timeout-sec", "30"]).args,
    ).toEqual({ changeId: "chg_1", until: "merged", timeoutSec: 30 });
    const bad = usageErrorOf(() => parse("wait-for-change", ["chg_1", "--until", "done"]));
    expect(bad.body.message).toMatch(/one of evidence_ready, lane_assigned/);
    usageErrorOf(() => parse("wait-for-change", ["chg_1", "--until", "merged", "--timeout-sec", "soon"]));
  });

  it("repeat list flags, accept JSON arrays, and take JSON for objects", () => {
    const { args } = parse("create-plan", [
      "--repo-id", "repo_1",
      "--title", "Rate limit",
      "--intent", "Stop credential stuffing.",
      "--acceptance-criteria", "6th try gets 429",
      "--acceptance-criteria", "counter resets",
      "--scope-paths", '["src/*.ts","test/*.ts"]',
      "--risk-declarations", '[{"area":"auth","description":"login path"}]',
    ]);
    expect(args).toEqual({
      repoId: "repo_1",
      title: "Rate limit",
      intent: "Stop credential stuffing.",
      acceptanceCriteria: ["6th try gets 429", "counter resets"],
      scopePaths: ["src/*.ts", "test/*.ts"],
      riskDeclarations: [{ area: "auth", description: "login path" }],
    });
    usageErrorOf(() => parse("create-plan", ["--risk-declarations", "{nope"]));
  });

  it("merge stdin < --json < positional < flags", () => {
    const stdin = JSON.stringify({ changeId: "from-stdin", until: "merged", timeoutSec: 5 });
    expect(parse("wait-for-change", ["-"], stdin).args).toEqual({
      changeId: "from-stdin",
      until: "merged",
      timeoutSec: 5,
    });
    expect(
      parse("wait-for-change", ["-", "--json", '{"changeId":"from-json","timeoutSec":9}'], stdin).args,
    ).toEqual({ changeId: "from-json", until: "merged", timeoutSec: 9 });
    expect(
      parse("wait-for-change", ["chg_pos", "--json", '{"changeId":"from-json","until":"merged"}', "--until", "reverted"]).args,
    ).toEqual({ changeId: "chg_pos", until: "reverted" });
    expect(parse("wait-for-change", ["--json", "-"], stdin).args.changeId).toBe("from-stdin");
  });

  it("pass --json keys the schema doesn't name straight through (the server validates)", () => {
    expect(parse("get-change-status", ["--json", '{"changeId":"c","extra":1}']).args).toEqual({
      changeId: "c",
      extra: 1,
    });
  });

  it("report missing required arguments before sending anything", () => {
    const err = usageErrorOf(() => parse("start-change", ["--repo-id", "r"]));
    expect(err.body.message).toBe("missing required --title, --category");
    expect(err.body.fix.command).toBe("gittifacts start-change --help");
    const pos = usageErrorOf(() => parse("get-change-status", []));
    expect(pos.body.message).toMatch(/<changeId> \(or --change-id\)/);
  });

  it("suggest the closest flag for a typo", () => {
    const err = usageErrorOf(() => parse("get-change-status", ["--chnage-id", "x"]));
    expect(err.body.message).toMatch(/did you mean --change-id/);
  });

  it("reject invalid JSON on stdin and non-object --json", () => {
    usageErrorOf(() => parse("get-change-status", ["-"], "not json"));
    usageErrorOf(() => parse("get-change-status", ["--json", "[1,2]"]));
    usageErrorOf(() => parse("get-change-status", ["a", "b"]));
  });

  it("treat everything after -- as positional", () => {
    const inv = splitArgv(["get-change-status", "--", "--weird-id"]);
    const s = spec("get-change-status");
    const parsed = parseCommandTokens(s, inv.tokens, inv.globals);
    expect(buildToolArgs(s, parsed, inv.globals, null)).toEqual({ changeId: "--weird-id" });
  });

  it("support boolean flags: --flag, --flag=false, --no-flag", () => {
    const s = deriveCommand(
      {
        name: "open_workspace",
        inputSchema: {
          type: "object",
          properties: { changeId: { type: "string" }, warm: { type: "boolean" } },
          required: ["changeId"],
        },
      },
      "server",
    );
    const values = (argv: string[]) => parseCommandTokens(s, argv, splitArgv([]).globals).values;
    expect(values(["--warm"])).toEqual({ warm: true });
    expect(values(["--warm=false"])).toEqual({ warm: false });
    expect(values(["--no-warm"])).toEqual({ warm: false });
    // a boolean never swallows the next token
    expect(parseCommandTokens(s, ["--warm", "chg_1"], splitArgv([]).globals).positionals).toEqual(["chg_1"]);
  });
});
