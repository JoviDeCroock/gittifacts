/**
 * The command table, generated from MCP tool definitions: one command per tool
 * (`get_change_status` → `gittifacts get-change-status`), one flag per top-level input property
 * (`changeId` → `--change-id`). Nothing here is hand-written per tool, so a tool added to
 * `@app/mcp` becomes a command on the next build, and a tool only the live server has is derived
 * the same way at runtime from `tools/list`.
 */
import { TOOL_DEFINITIONS } from "./definitions.js";
import { type JsonSchema, schemaTypes, type WireTool } from "./schema.js";

export type FlagKind = "string" | "integer" | "number" | "boolean" | "enum" | "json";

export interface FlagSpec {
  /** `--change-id` */
  flag: string;
  /** The input property it sets (`changeId`). */
  property: string;
  kind: FlagKind;
  /** Arrays of primitives: the flag repeats, each occurrence appends one item. */
  list: boolean;
  required: boolean;
  description?: string | undefined;
  /** For `kind: "enum"` (or a list of enums): the allowed values. */
  values?: readonly (string | number | boolean | null)[] | undefined;
  /** Placeholder in usage text, e.g. `<string>`. */
  placeholder: string;
}

export interface CommandSpec {
  /** `get-change-status` */
  command: string;
  /** `get_change_status` (null for local commands such as `login`). */
  tool: string | null;
  title?: string | undefined;
  description: string;
  /** Not annotated read-only: sends an idempotency key. */
  mutating: boolean;
  /** The input schema declares `idempotencyKey`, so the key also travels as an argument. */
  idempotencyArg: boolean;
  /** Property filled by the first positional argument, if any. */
  positional: string | null;
  flags: FlagSpec[];
  /** Where the definition came from: built into this CLI, the live server, or the CLI itself. */
  source: "bundled" | "server" | "builtin";
  inputSchema: JsonSchema;
}

export const IDEMPOTENCY_PROPERTY = "idempotencyKey";

export function commandName(tool: string): string {
  return tool.replaceAll("_", "-").toLowerCase();
}

export function toolNameOf(command: string): string {
  return command.replaceAll("-", "_");
}

/** `changeId` → `change-id`, `timeout_sec` → `timeout-sec`. */
export function kebab(property: string): string {
  return property
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1-$2")
    .replaceAll("_", "-")
    .toLowerCase();
}

type Primitive = string | number | boolean | null;

function primitiveValues(s: JsonSchema): Primitive[] | null {
  const values = s.enum ?? (s.const !== undefined ? [s.const] : undefined);
  if (!values) return null;
  const out = values.filter(
    (v): v is Primitive =>
      v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean",
  );
  return out.length === values.length ? out : null;
}

function scalarKind(s: JsonSchema): { kind: FlagKind; values?: Primitive[] } | null {
  const values = primitiveValues(s);
  if (values) return { kind: "enum", values };
  const types = schemaTypes(s);
  if (types.length !== 1) return null;
  switch (types[0]) {
    case "string":
      return { kind: "string" };
    case "integer":
      return { kind: "integer" };
    case "number":
      return { kind: "number" };
    case "boolean":
      return { kind: "boolean" };
    default:
      return null;
  }
}

export function flagFor(property: string, s: JsonSchema, required: boolean): FlagSpec {
  const base = { flag: `--${kebab(property)}`, property, required, description: s.description };
  const scalar = scalarKind(s);
  if (scalar) {
    return {
      ...base,
      kind: scalar.kind,
      list: false,
      values: scalar.values,
      placeholder: placeholderOf(scalar.kind, scalar.values),
    };
  }
  if (schemaTypes(s).length === 1 && schemaTypes(s)[0] === "array" && s.items) {
    const item = scalarKind(s.items);
    if (item && item.kind !== "boolean") {
      return {
        ...base,
        kind: item.kind,
        list: true,
        values: item.values,
        placeholder: `${placeholderOf(item.kind, item.values)}...`,
      };
    }
  }
  return { ...base, kind: "json", list: false, placeholder: "<json>" };
}

function placeholderOf(kind: FlagKind, values?: readonly Primitive[]): string {
  if (kind === "enum" && values) return `<${values.map(String).join("|")}>`;
  if (kind === "boolean") return "";
  return `<${kind}>`;
}

/** Derives a command from one tool definition (bundled or from a live `tools/list`). */
export function deriveCommand(tool: WireTool, source: "bundled" | "server"): CommandSpec {
  const props = tool.inputSchema.properties ?? {};
  const required = new Set(tool.inputSchema.required ?? []);
  const flags = Object.entries(props)
    .filter(([name]) => name !== IDEMPOTENCY_PROPERTY)
    .map(([name, s]) => flagFor(name, s, required.has(name)));
  // One required string argument reads naturally as a positional: `get-change-status chg_1`.
  const requiredStrings = flags.filter((f) => f.required && f.kind === "string" && !f.list);
  const requiredAll = flags.filter((f) => f.required);
  // A change named either by id or (GitHub mode) by `--github owner/repo#123`: neither is
  // required, and the id stays positional (`get-change-status chg_1`).
  const changeIdFallback =
    requiredStrings.length === 0 &&
    flags.some((f) => f.property === "changeId" && f.kind === "string")
      ? "changeId"
      : null;
  const positional =
    requiredStrings.length === 1 && requiredAll.length >= 1
      ? (requiredStrings[0]?.property ?? null)
      : changeIdFallback;
  return {
    command: commandName(tool.name),
    tool: tool.name,
    title: tool.title,
    description: (tool.description ?? tool.title ?? tool.name).trim(),
    mutating: tool.annotations?.readOnlyHint !== true,
    idempotencyArg: IDEMPOTENCY_PROPERTY in props,
    positional,
    flags,
    source,
    inputSchema: tool.inputSchema,
  };
}

let bundled: CommandSpec[] | null = null;

/** Commands for every tool this CLI was built against, in definition order. */
export function bundledCommands(): CommandSpec[] {
  bundled ??= TOOL_DEFINITIONS.map((t) => deriveCommand(t, "bundled"));
  return bundled;
}

export function findCommand(
  name: string,
  table: readonly CommandSpec[] = bundledCommands(),
): CommandSpec | undefined {
  const wanted = commandName(name);
  return table.find((c) => c.command === wanted);
}

export function usageOf(spec: CommandSpec): string {
  const parts = [`gittifacts ${spec.command}`];
  const positional = spec.flags.find((f) => f.property === spec.positional);
  if (positional) parts.push(`<${positional.property}>`);
  for (const f of spec.flags) {
    if (f.property === spec.positional) continue;
    const text = f.placeholder ? `${f.flag} ${f.placeholder}` : f.flag;
    parts.push(f.required ? text : `[${text}]`);
  }
  if (spec.mutating) parts.push("[--idempotency-key <key>]");
  return parts.join(" ");
}

/** A short description for tables: the first sentence. */
export function summaryOf(spec: Pick<CommandSpec, "description">): string {
  const first = /^(.+?[.!?])(\s|$)/.exec(spec.description);
  return (first?.[1] ?? spec.description).trim();
}
