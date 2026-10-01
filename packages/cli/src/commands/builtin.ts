/**
 * Local commands (init, login, wait, ...) declare their flags in the same FlagSpec shape the
 * generated commands derive from schemas, so parsing, `--help` and usage text are shared.
 */
import type { ParsedArgs } from "../args.js";
import type { Ctx } from "../context.js";
import { usageError } from "../errors.js";
import { type CommandSpec, type FlagSpec, flagFor } from "../tools/commands.js";
import type { JsonSchema } from "../tools/schema.js";

export interface Builtin {
  spec: CommandSpec;
  /** Usage examples for `--help`. */
  examples?: string[];
  run(ctx: Ctx, parsed: ParsedArgs): Promise<number>;
}

export function builtinSpec(def: {
  command: string;
  tool?: string | undefined;
  title: string;
  description: string;
  properties: Record<string, JsonSchema>;
  required?: string[];
  positional?: string;
  mutating?: boolean;
}): CommandSpec {
  const required = new Set(def.required ?? []);
  const flags: FlagSpec[] = Object.entries(def.properties).map(([name, s]) =>
    flagFor(name, s, required.has(name)),
  );
  return {
    command: def.command,
    tool: def.tool ?? null,
    title: def.title,
    description: def.description,
    mutating: def.mutating ?? false,
    idempotencyArg: false,
    positional: def.positional ?? null,
    flags,
    source: "builtin",
    inputSchema: { type: "object", properties: def.properties, required: [...required] },
  };
}

export function str(parsed: ParsedArgs, name: string): string | undefined {
  const v = parsed.values[name];
  return typeof v === "string" ? v : undefined;
}

export function bool(parsed: ParsedArgs, name: string): boolean {
  return parsed.values[name] === true;
}

export function int(parsed: ParsedArgs, name: string): number | undefined {
  const v = parsed.values[name];
  return typeof v === "number" ? v : undefined;
}

/** The positional (if the command takes one) or its flag value. */
export function positionalOr(
  spec: CommandSpec,
  parsed: ParsedArgs,
  name: string,
  max = 1,
): string | undefined {
  if (parsed.positionals.length > max) {
    throw usageError(`unexpected arguments: ${parsed.positionals.slice(max).join(" ")}`, {
      explanation: `See \`gittifacts ${spec.command} --help\`.`,
      command: `gittifacts ${spec.command} --help`,
    });
  }
  return parsed.positionals[0] ?? str(parsed, name);
}

export function requireValue(spec: CommandSpec, value: string | undefined, flag: string): string {
  if (value === undefined || value === "") {
    throw usageError(`missing required ${flag}`, {
      explanation: `See \`gittifacts ${spec.command} --help\`.`,
      command: `gittifacts ${spec.command} --help`,
    });
  }
  return value;
}
