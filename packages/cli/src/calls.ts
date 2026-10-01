/**
 * The platform writes next steps and fixes as MCP calls (`get_change_status({ changeId: "c_1" })`,
 * the notation `@app/conventions` `call()` produces). The CLI adds the same step as a shell
 * command (`gittifacts get-change-status --change-id c_1`), so an agent that only has the CLI can
 * run it as-is.
 */
import { type CommandSpec, commandName, findCommand, kebab } from "./tools/commands.js";
import { isRecord } from "./tools/schema.js";

export interface ParsedCall {
  tool: string;
  args: Record<string, unknown>;
}

/** Quotes bare object keys outside string literals, turning call notation into JSON. */
function quoteKeys(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const ch = source[i] ?? "";
    if (ch === '"') {
      let j = i + 1;
      while (j < source.length && source[j] !== '"') j += source[j] === "\\" ? 2 : 1;
      out += source.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    const key = /^[A-Za-z_$][\w$]*(?=\s*:)/.exec(source.slice(i));
    const prev = out.trimEnd().at(-1);
    if (key !== null && (prev === "{" || prev === ",")) {
      out += JSON.stringify(key[0]);
      i += key[0].length;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** Parses `tool_name({ ... })`. Returns null when malformed. */
export function parseCall(text: string): ParsedCall | null {
  const match = /^([a-z][a-z0-9_]*)\((\{[\s\S]*\})?\)$/.exec(text.trim());
  if (match === null) return null;
  const [, tool, body] = match;
  if (tool === undefined) return null;
  if (body === undefined) return { tool, args: {} };
  try {
    const args: unknown = JSON.parse(quoteKeys(body));
    return isRecord(args) ? { tool, args } : null;
  } catch {
    return null;
  }
}

const SAFE = /^[A-Za-z0-9_\-.,:/@%+=]+$/;

/** POSIX shell quoting. Placeholders like `<changeId>` get quoted so they can't redirect. */
export function shellQuote(s: string): string {
  if (s.length > 0 && SAFE.test(s)) return s;
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

function scalar(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v);
}

function flagFor(spec: CommandSpec | undefined, property: string): string {
  return spec?.flags.find((f) => f.property === property)?.flag ?? `--${kebab(property)}`;
}

/**
 * The CLI command for an MCP call. Tools with a friendlier local command map to it
 * (`wait_for_change` → `gittifacts wait`, `create_project` → `gittifacts init`).
 */
export function callToCommand(call: ParsedCall, table?: readonly CommandSpec[]): string {
  const args = { ...call.args };
  const parts = ["gittifacts"];
  let spec: CommandSpec | undefined = findCommand(call.tool, table);
  if (call.tool === "wait_for_change" && typeof args.changeId === "string") {
    parts.push("wait", shellQuote(args.changeId));
    delete args.changeId;
    if (args.timeoutSec !== undefined) {
      parts.push("--timeout", shellQuote(scalar(args.timeoutSec)));
      delete args.timeoutSec;
    }
  } else if (call.tool === "create_project") {
    parts.push("init");
    spec = undefined;
  } else {
    parts.push(spec?.command ?? commandName(call.tool));
  }
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;
    const flag = flagFor(spec, key);
    const kind = spec?.flags.find((f) => f.property === key);
    if (Array.isArray(value) && value.every((x) => typeof x !== "object" || x === null)) {
      if (kind && kind.kind === "json") parts.push(flag, shellQuote(JSON.stringify(value)));
      else for (const item of value) parts.push(flag, shellQuote(scalar(item)));
    } else if (typeof value === "object") {
      parts.push(flag, shellQuote(JSON.stringify(value)));
    } else if (value === true && kind?.kind === "boolean") {
      parts.push(flag);
    } else {
      parts.push(flag, shellQuote(scalar(value)));
    }
  }
  return parts.join(" ");
}

export function commandForCall(text: string, table?: readonly CommandSpec[]): string | null {
  const parsed = parseCall(text);
  return parsed ? callToCommand(parsed, table) : null;
}

/**
 * Adds `command` to every NextStep (`{ title, call }`) and ErrorFix (`{ explanation, call }`) that
 * has a `call` but no `command`, anywhere in `doc`.
 */
export function withCommands<T>(doc: T, table?: readonly CommandSpec[]): T {
  if (Array.isArray(doc)) return doc.map((d: unknown) => withCommands(d, table)) as T;
  if (!isRecord(doc)) return doc;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc)) out[k] = withCommands(v, table);
  const isStep = typeof out.title === "string" || typeof out.explanation === "string";
  if (isStep && typeof out.call === "string" && out.command === undefined) {
    const command = commandForCall(out.call, table);
    if (command !== null) out.command = command;
  }
  return out as T;
}
