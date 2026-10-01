/**
 * Self-description: `help`, `<command> --help`, `tools` (the generated command table) and
 * `search-tools` (local fuzzy search, the offline twin of the MCP `search_tools`).
 */
import { GLOBAL_FLAGS } from "../args.js";
import type { Ctx } from "../context.js";
import { EXIT } from "../errors.js";
import { table } from "../human.js";
import {
  bundledCommands,
  type CommandSpec,
  deriveCommand,
  summaryOf,
  usageOf,
} from "../tools/commands.js";
import { toWireTool } from "../tools/schema.js";
import { searchCommands } from "../tools/search.js";
import { CLI_NAME, CLI_VERSION } from "../version.js";
import type { Builtin } from "./builtin.js";

export const EXIT_CODES: Record<string, string> = {
  [EXIT.ok]: "success",
  [EXIT.error]: "error: `{ error: { code, message, fix } }` on stdout",
  [EXIT.usage]: "usage error (unknown command/flag, missing argument); nothing was sent",
  [EXIT.notReached]: "wait: the milestone was not reached (timeout or unreachable)",
  [EXIT.interrupted]: "interrupted (Ctrl-C)",
};

export const ENV_VARS: Record<string, string> = {
  GITTIFACTS_HOST: "platform origin (overrides .gittifacts.json and the last login)",
  GITTIFACTS_TOKEN: "bearer token (overrides stored credentials)",
  GITTIFACTS_CONFIG_DIR: "credentials directory (default ~/.config/gittifacts)",
  NO_COLOR: "no color in --human output",
};

export const QUICKSTART = [
  "gittifacts init --template workers-api --name my-api --clone",
  "gittifacts wait <changeId> --until evidence_ready",
  "gittifacts get-change-status <changeId> --human",
  "gittifacts create-plan --repo-id <projectId> --title ... --intent ... --acceptance-criteria ...",
  "gittifacts start-change --repo-id <projectId> --plan-id <planId> --title ... --category feature",
];

function flagDoc(spec: CommandSpec) {
  return spec.flags.map((f) => ({
    flag: f.flag,
    property: f.property,
    type: f.list ? `${f.kind}[]` : f.kind,
    required: f.required,
    ...(f.property === spec.positional ? { positional: true } : {}),
    ...(f.values ? { values: f.values } : {}),
    ...(f.description ? { description: f.description } : {}),
  }));
}

export function describeCommand(spec: CommandSpec, examples?: string[]) {
  return {
    command: spec.command,
    tool: spec.tool,
    title: spec.title ?? null,
    description: spec.description,
    usage: usageOf(spec),
    mutating: spec.mutating,
    source: spec.source,
    flags: flagDoc(spec),
    ...(examples && examples.length > 0 ? { examples } : {}),
  };
}

export function commandHelp(ctx: Ctx, spec: CommandSpec, examples?: string[]): number {
  const doc = describeCommand(spec, examples);
  if (!ctx.out.human) {
    ctx.out.result(doc);
    return EXIT.ok;
  }
  const s = ctx.out.style;
  const lines = [s.bold(doc.usage), "", spec.description, ""];
  if (spec.tool && spec.source !== "builtin") lines.push(`MCP tool: ${spec.tool}`, "");
  const rows = doc.flags.map((f) => ({
    flag: f.positional ? `${f.flag} (or positional)` : f.flag,
    type: "values" in f && f.values ? f.values.map(String).join("|") : f.type,
    required: f.required ? "yes" : "",
    description: f.description ?? "",
  }));
  if (rows.length > 0) lines.push(...table(rows, { style: s, width: 100 }), "");
  if (spec.mutating) lines.push("Sends an idempotency key (printed in the output; reuse it with --idempotency-key to retry).", "");
  if (spec.source !== "builtin") {
    lines.push("Raw arguments: --json '<object>' or `-` to read them from stdin.", "");
  }
  if (examples) lines.push("Examples:", ...examples.map((e) => `  ${e}`), "");
  ctx.io.stdout.write(`${lines.join("\n").trimEnd()}\n`);
  return EXIT.ok;
}

export function topHelp(ctx: Ctx, builtins: readonly Builtin[]): number {
  const commands = [
    ...builtins.map((b) => ({ command: b.spec.command, summary: summaryOf(b.spec), source: "builtin", tool: b.spec.tool })),
    ...bundledCommands().map((c) => ({ command: c.command, summary: summaryOf(c), source: "mcp", tool: c.tool })),
  ];
  const doc = {
    name: CLI_NAME,
    version: CLI_VERSION,
    usage: "gittifacts <command> [flags]",
    output:
      "One JSON document on stdout (errors too: { error: { code, message, fix } }). --human for text. Next steps and fixes carry an MCP `call` and the matching CLI `command`.",
    commands,
    globalFlags: GLOBAL_FLAGS.map((f) => ({ flag: f.flag, description: f.description })),
    exitCodes: EXIT_CODES,
    env: ENV_VARS,
    quickstart: QUICKSTART,
  };
  if (!ctx.out.human) {
    ctx.out.result(doc);
    return EXIT.ok;
  }
  const s = ctx.out.style;
  const lines = [
    `${s.bold(`gittifacts ${CLI_VERSION}`)}: the agent-native git platform from your shell.`,
    "",
    `Usage: ${doc.usage}`,
    "",
    s.bold("Commands (local)"),
    ...table(
      commands.filter((c) => c.source === "builtin").map((c) => ({ command: c.command, summary: c.summary })),
      { style: s, width: 100, indent: 2 },
    ),
    "",
    s.bold("Commands (one per MCP tool)"),
    ...table(
      commands.filter((c) => c.source === "mcp").map((c) => ({ command: c.command, summary: c.summary })),
      { style: s, width: 100, indent: 2 },
    ),
    "",
    s.bold("Global flags"),
    ...GLOBAL_FLAGS.map((f) => `  ${`${f.flag} ${f.placeholder}`.trim().padEnd(28)} ${f.description}`),
    "",
    s.bold("Ship something"),
    ...QUICKSTART.map((q, i) => `  ${i + 1}. ${q}`),
    "",
    s.bold("Exit codes"),
    ...Object.entries(EXIT_CODES).map(([code, d]) => `  ${code.padEnd(4)} ${d}`),
    "",
    "Run `gittifacts <command> --help` for flags. Output is JSON unless --human.",
  ];
  ctx.io.stdout.write(`${lines.join("\n")}\n`);
  return EXIT.ok;
}

/** The commands: from this build's tool definitions, or (`--remote`) from the live server. */
export async function commandTable(ctx: Ctx, remote: boolean): Promise<CommandSpec[]> {
  if (!remote) return bundledCommands();
  const target = ctx.target();
  const tools = await ctx.withConnection(target, "tools", {}, ({ mcp }) => mcp.listTools());
  return tools
    .map(toWireTool)
    .filter((t) => t !== null)
    .map((t) => deriveCommand(t, "server"));
}

export async function listTools(ctx: Ctx, remote: boolean, builtins: readonly Builtin[]): Promise<number> {
  const commands = await commandTable(ctx, remote);
  const bundledNames = new Set(bundledCommands().map((c) => c.command));
  const doc = {
    source: remote ? "server" : "bundled",
    ...(remote ? { host: ctx.target().host } : {}),
    tools: commands.map((c) => ({
      command: c.command,
      tool: c.tool,
      title: c.title ?? null,
      description: c.description,
      mutating: c.mutating,
      usage: usageOf(c),
      ...(remote ? { inThisCli: bundledNames.has(c.command) } : {}),
    })),
    builtins: builtins.map((b) => ({
      command: b.spec.command,
      description: b.spec.description,
      ...(b.spec.tool ? { tool: b.spec.tool } : {}),
    })),
  };
  if (!ctx.out.human) {
    ctx.out.result(doc);
    return EXIT.ok;
  }
  const s = ctx.out.style;
  const rows = doc.tools.map((t) => ({
    command: t.command,
    writes: t.mutating ? "yes" : "",
    summary: summaryOf(t),
  }));
  ctx.io.stdout.write(
    `${[
      s.bold(remote ? `Tools on ${ctx.target().host}` : "Tools (bundled with this CLI)"),
      ...table(rows, { style: s, width: 100 }),
      "",
      `Local: ${builtins.map((b) => b.spec.command).join(", ")}`,
    ].join("\n")}\n`,
  );
  return EXIT.ok;
}

export async function searchTools(
  ctx: Ctx,
  query: string,
  opts: { remote: boolean; limit: number },
  builtins: readonly Builtin[],
): Promise<number> {
  const commands = [...(await commandTable(ctx, opts.remote)), ...builtins.map((b) => b.spec)];
  const results = searchCommands(query, commands, opts.limit).map((h) => {
    const spec = commands.find((c) => c.command === h.command);
    return { ...h, usage: spec ? usageOf(spec) : `gittifacts ${h.command}` };
  });
  ctx.out.result(
    { query, source: opts.remote ? "server" : "bundled", results },
    { title: `Tools matching "${query}"` },
  );
  return EXIT.ok;
}
