/**
 * Dispatch: local commands first (init, login, logout, wait, tools, search-tools, help), then one
 * command per MCP tool from this build's table, then (for a tool newer than this build) the live
 * server's `tools/list`. Every failure ends as one `{ error }` document and an exit code.
 */
import { parseCommandTokens, splitArgv } from "./args.js";
import { Ctx } from "./context.js";
import { CliError, EXIT, RETRYABLE_CODES } from "./errors.js";
import { toCliError } from "./failures.js";
import type { CliIo } from "./io.js";
import { Output } from "./output.js";
import { login, logout } from "./commands/auth.js";
import { type Builtin, bool, builtinSpec, int } from "./commands/builtin.js";
import { commandHelp, listTools, searchTools, topHelp } from "./commands/help.js";
import { init } from "./commands/init.js";
import { resolveRemoteCommand, runToolCommand } from "./commands/tool.js";
import { wait } from "./commands/wait.js";
import { bundledCommands, findCommand } from "./tools/commands.js";
import { suggest } from "./tools/search.js";
import { usageError } from "./errors.js";
import { CLI_NAME, CLI_VERSION } from "./version.js";

const tools: Builtin = {
  spec: builtinSpec({
    command: "tools",
    title: "List commands",
    description:
      "List the commands generated from MCP tools (bundled with this CLI, or --remote: what the live server offers now).",
    properties: { remote: { type: "boolean", description: "Ask the server's tools/list instead." } },
  }),
  run: (ctx, parsed) => listTools(ctx, bool(parsed, "remote"), BUILTINS),
};

const search: Builtin = {
  spec: builtinSpec({
    command: "search-tools",
    title: "Search tools",
    description:
      "Fuzzy-search command names and descriptions (offline; mirrors the MCP search_tools). --remote searches the live server's tools.",
    properties: {
      query: { type: "string", description: "What you want to do, in words." },
      remote: { type: "boolean", description: "Search the server's tools/list." },
      limit: { type: "integer", description: "Maximum results (default 5)." },
    },
    positional: "query",
  }),
  examples: ['gittifacts search-tools "wait for ci"', "gittifacts search-tools review"],
  async run(ctx, parsed) {
    const query = [...parsed.positionals, ...(typeof parsed.values.query === "string" ? [parsed.values.query] : [])].join(" ");
    if (query.trim() === "") {
      throw usageError("search-tools needs a query", {
        explanation: "Describe what you want to do, e.g. `gittifacts search-tools wait for evidence`.",
        command: "gittifacts tools",
      });
    }
    return searchTools(ctx, query, { remote: bool(parsed, "remote"), limit: int(parsed, "limit") ?? 5 }, BUILTINS);
  },
};

const help: Builtin = {
  spec: builtinSpec({
    command: "help",
    title: "Help",
    description: "Usage, commands, global flags and exit codes; `help <command>` for one command.",
    properties: { command: { type: "string" } },
    positional: "command",
  }),
  async run(ctx, parsed) {
    const name = parsed.positionals[0];
    if (!name) return topHelp(ctx, BUILTINS);
    const builtin = BUILTINS.find((b) => b.spec.command === name);
    if (builtin) return commandHelp(ctx, builtin.spec, builtin.examples);
    const spec = findCommand(name) ?? (await resolveRemoteCommand(ctx, name));
    if (spec) return commandHelp(ctx, spec);
    throw unknownCommand(name);
  },
};

export const BUILTINS: readonly Builtin[] = [init, login, logout, wait, tools, search, help];

function unknownCommand(name: string): CliError {
  const names = [...BUILTINS.map((b) => b.spec.command), ...bundledCommands().map((c) => c.command)];
  const near = suggest(name, names);
  return usageError(
    `unknown command: ${name}${near.length > 0 ? ` (did you mean ${near.join(", ")}?)` : ""}`,
    {
      explanation:
        "Commands are the platform's MCP tools with dashes (get_change_status → get-change-status) plus a few local ones. This build doesn't know it, and the server (if configured) doesn't offer it either.",
      command: near[0] ? `gittifacts ${near[0]} --help` : "gittifacts tools --remote",
    },
    { suggestions: near },
  );
}

async function dispatch(ctx: Ctx, command: string | null, tokens: readonly string[]): Promise<number> {
  const g = ctx.globals;
  if (g.version && command === null) {
    ctx.out.result({ name: CLI_NAME, version: CLI_VERSION });
    return EXIT.ok;
  }
  if (command === null) return topHelp(ctx, BUILTINS);
  const builtin = BUILTINS.find((b) => b.spec.command === command);
  if (builtin) {
    const parsed = parseCommandTokens(builtin.spec, tokens, g);
    if (g.help) return commandHelp(ctx, builtin.spec, builtin.examples);
    return builtin.run(ctx, parsed);
  }
  const spec = findCommand(command) ?? (await resolveRemoteCommand(ctx, command));
  if (!spec) throw unknownCommand(command);
  return runToolCommand(ctx, spec, tokens);
}

/** Runs the CLI; returns the exit code. Never throws. */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  // Decided up front: `--human` may follow the command, and errors while parsing render in it too.
  const ddash = argv.indexOf("--");
  const human = (ddash < 0 ? argv : argv.slice(0, ddash)).includes("--human");
  const out = new Output(io, human);
  let ctx = new Ctx(io, argv, { human, help: false, version: false }, out);
  try {
    const inv = splitArgv(argv);
    ctx = new Ctx(io, argv, inv.globals, out);
    return await dispatch(ctx, inv.command, inv.tokens);
  } catch (e) {
    const err =
      e instanceof CliError
        ? e
        : toCliError(e, { host: "", mcpUrl: "", command: argv[0] ?? "", tokenSource: null });
    const key = err.meta.idempotencyKey;
    if (typeof key === "string" && RETRYABLE_CODES.has(err.body.code)) {
      err.body.fix = { ...err.body.fix, command: ctx.retryCommand(key) };
    }
    ctx.out.error(err.body, err.meta);
    return err.exitCode;
  }
}
