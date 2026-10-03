/**
 * The generated commands: one MCP tool call each. Arguments come from flags / `--json` / stdin;
 * the output is the tool's `structuredContent`, with a shell `command` added next to every
 * `call` in next steps and fixes.
 */
import { buildToolArgs, parseCommandTokens } from "../args.js";
import { withCommands } from "../calls.js";
import type { Ctx, Target } from "../context.js";
import { CliError, cliError, EXIT, parseEnvelope } from "../errors.js";
import { type AnyToolResult, callAnyTool, type RequestOptions } from "../mcp.js";
import {
  bundledCommands,
  type CommandSpec,
  commandName,
  deriveCommand,
  toolNameOf,
} from "../tools/commands.js";
import { isRecord, toWireTool } from "../tools/schema.js";
import { HUMAN_VIEWS } from "../views.js";
import { commandHelp } from "./help.js";

function firstText(r: AnyToolResult): string {
  for (const block of r.content ?? []) if (block.type === "text") return block.text;
  return "";
}

/** A failed tool result as a CliError: the platform envelope when there is one. */
export function toolFailure(spec: Pick<CommandSpec, "command">, r: AnyToolResult): CliError {
  const text = firstText(r);
  const envelope = parseEnvelope(text);
  if (envelope) return new CliError(withCommands(envelope, bundledCommands()));
  const help = `gittifacts ${spec.command} --help`;
  if (/^Invalid input for tool/i.test(text)) {
    return cliError(
      "invalid-request",
      text.split("\n")[0] ?? text,
      {
        explanation:
          "The arguments don't match the tool's input schema (see details). Fix them and run again.",
        command: help,
      },
      { details: text.split("\n").slice(1).filter(Boolean) },
    );
  }
  return cliError("tool-error", text || "the tool reported an error without a message", {
    explanation: "Read the message; `--help` shows what the command expects.",
    command: help,
  });
}

/** A successful result as a JSON object (structured content, else the text parsed as JSON). */
export function resultDocument(r: AnyToolResult): Record<string, unknown> {
  if (isRecord(r.structuredContent)) return r.structuredContent;
  const text = firstText(r);
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed)) return parsed;
    return { result: parsed };
  } catch {
    return { content: r.content ?? [] };
  }
}

export async function callTool(
  ctx: Ctx,
  target: Target,
  spec: CommandSpec,
  args: Record<string, unknown>,
  opts: { idempotencyKey?: string | undefined; request?: RequestOptions } = {},
): Promise<Record<string, unknown>> {
  const key = opts.idempotencyKey;
  const tool = spec.tool ?? toolNameOf(spec.command);
  return ctx.withConnection(
    target,
    spec.command,
    {
      headers: key ? { "Idempotency-Key": key } : {},
      meta: key ? { idempotencyKey: key } : {},
    },
    async ({ mcp }) => {
      const r = await callAnyTool(mcp, tool, args, opts.request);
      if (r.isError) throw toolFailure(spec, r);
      return resultDocument(r);
    },
  );
}

/** Looks a command up on the live server (a tool newer than this build). */
export async function resolveRemoteCommand(ctx: Ctx, name: string): Promise<CommandSpec | null> {
  const target = ctx.targetOrNull();
  if (!target) return null;
  try {
    return await ctx.withConnection(target, name, {}, async ({ mcp }) => {
      const tools = await mcp.listTools();
      const wanted = toolNameOf(commandName(name));
      const hit = tools.map(toWireTool).find((t) => t !== null && t.name === wanted);
      return hit ? deriveCommand(hit, "server") : null;
    });
  } catch {
    return null;
  }
}

/** Default client-side budget: above the platform's default long-poll (120s), unlike the SDK's 60s. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 180_000;

/** Long-polling tools take `timeoutSec`; give the request that long plus a margin. */
export function requestTimeoutMs(args: Record<string, unknown>): number {
  const sec = args.timeoutSec;
  return typeof sec === "number" && Number.isFinite(sec)
    ? Math.max(DEFAULT_REQUEST_TIMEOUT_MS, (sec + 30) * 1000)
    : DEFAULT_REQUEST_TIMEOUT_MS;
}

export async function runToolCommand(
  ctx: Ctx,
  spec: CommandSpec,
  tokens: readonly string[],
): Promise<number> {
  const parsed = parseCommandTokens(spec, tokens, ctx.globals);
  if (ctx.globals.help) return commandHelp(ctx, spec);
  const needsStdin = parsed.stdin || ctx.globals.json === "-";
  const stdinText = needsStdin ? await ctx.io.readStdin() : null;
  const args = buildToolArgs(spec, parsed, ctx.globals, stdinText);
  let key: string | undefined;
  if (spec.mutating) {
    const given = typeof args.idempotencyKey === "string" ? args.idempotencyKey : undefined;
    key = given ?? ctx.globals.idempotencyKey ?? ctx.newIdempotencyKey();
    if (spec.idempotencyArg) args.idempotencyKey = key;
  }
  const target = ctx.target();
  const doc = await callTool(ctx, target, spec, args, {
    idempotencyKey: key,
    request: { timeout: requestTimeoutMs(args), resetTimeoutOnProgress: true },
  });
  let out: Record<string, unknown> = withCommands(doc, bundledCommands());
  if (spec.tool === "whoami") {
    out = {
      ...out,
      auth: {
        host: target.host,
        hostSource: target.hostSource,
        tokenSource: target.token?.source ?? null,
        expiresAt: target.token?.expiresAt ?? null,
      },
    };
  }
  if (key) out = { ...out, idempotencyKey: key };
  const tool = spec.tool ?? toolNameOf(spec.command);
  ctx.out.result(out, { title: spec.title ?? spec.command, view: HUMAN_VIEWS[tool] });
  return EXIT.ok;
}
