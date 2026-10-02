/**
 * CLI reference, from the CLI's own command table: the local commands (`BUILTINS`), the commands
 * derived from the MCP tools (`bundledCommands()`), global flags, environment and exit codes.
 */
import { GLOBAL_FLAGS } from "gittifacts/src/args.js";
import { ENV_VARS, EXIT_CODES } from "gittifacts/src/commands/help.js";
import { BUILTINS } from "gittifacts/src/main.js";
import { bundledCommands, type CommandSpec, summaryOf, usageOf } from "gittifacts/src/tools/commands.js";
import { CLI_VERSION } from "gittifacts/src/version.js";
import { cell, code, fence, type GeneratedPage, header, join, table } from "./lib/md.js";

function flagRows(spec: CommandSpec): string[][] {
  return spec.flags.map((f) => [
    code(f.flag),
    cell(f.list ? `${f.kind}[] (repeat the flag)` : f.kind === "enum" ? (f.values ?? []).map((v) => String(v)).join(" | ") : f.kind),
    f.required ? "yes" : "",
    cell([f.property === spec.positional ? "Also the first positional argument." : "", f.description ?? ""].filter(Boolean).join(" ")),
  ]);
}

function builtinSection(b: (typeof BUILTINS)[number]): string {
  const spec = b.spec;
  const rows = flagRows(spec);
  return join(
    `### \`gittifacts ${spec.command}\``,
    spec.description,
    fence("text", usageOf(spec)),
    rows.length === 0 ? "" : table(["Flag", "Type", "Required", "Notes"], rows),
    b.examples && b.examples.length > 0 ? `Examples: ${b.examples.map(code).join(", ")}.` : "",
  );
}

export function generateCli(): GeneratedPage[] {
  const commands = bundledCommands();
  const content = join(
    header(
      {
        title: "CLI reference",
        nav: "CLI",
        description: `Every gittifacts CLI command (v${CLI_VERSION}): local commands, one command per MCP tool, global flags, environment variables and exit codes.`,
        order: 20,
      },
      ["packages/cli/src/main.ts", "packages/cli/src/tools/commands.ts", "packages/cli/src/args.ts", "packages/cli/src/commands/help.ts"],
      "The CLI prints exactly one JSON document on stdout (errors too) and `--human` tables on request. Every MCP tool is a command: `get_change_status` becomes `gittifacts get-change-status`, and each argument becomes a flag (`changeId` → `--change-id`). A single required string argument can also be passed positionally.",
    ),
    "## Global flags",
    table(
      ["Flag", "Notes"],
      GLOBAL_FLAGS.map((f) => [cell(code(f.placeholder === "" ? f.flag : `${f.flag} ${f.placeholder}`)), cell(f.description)]),
    ),
    "## Environment",
    table(["Variable", "Meaning"], Object.entries(ENV_VARS).map(([k, v]) => [code(k), cell(v)])),
    "## Exit codes",
    table(["Code", "Meaning"], Object.entries(EXIT_CODES).map(([k, v]) => [code(k), cell(v)])),
    "## Local commands",
    "These run in the CLI itself (some call one MCP tool on your behalf).",
    ...BUILTINS.map(builtinSection),
    "## Tool commands",
    "One per MCP tool. Arguments, scopes and outputs are in the [MCP tools](/docs/reference/mcp-tools) reference. Mutating commands send an idempotency key and print it; pass `--idempotency-key <key>` to retry without acting twice. `--json '{...}'` (or `--json -` for stdin) passes raw arguments.",
    table(
      ["Command", "Tool", "Usage"],
      commands.map((c) => [code(`gittifacts ${c.command}`), code(c.tool ?? ""), cell(`${code(usageOf(c))} — ${summaryOf(c)}`)]),
    ),
  );
  return [{ file: "reference/cli.md", content }];
}
