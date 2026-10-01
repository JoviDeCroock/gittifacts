/**
 * argv parsing in two phases: global flags and the command name first, then the command's own
 * flags (derived from its input schema). Arguments merge in this order, later wins:
 * stdin JSON (`-`) → `--json '<object>'` → positional → flags.
 */
import { usageError } from "./errors.js";
import {
  type CommandSpec,
  type FlagSpec,
  IDEMPOTENCY_PROPERTY,
  kebab,
  usageOf,
} from "./tools/commands.js";
import { isRecord } from "./tools/schema.js";
import { suggest } from "./tools/search.js";

export interface Globals {
  host?: string | undefined;
  human: boolean;
  /** Raw tool arguments as a JSON object, or `-` for stdin. */
  json?: string | undefined;
  idempotencyKey?: string | undefined;
  help: boolean;
  version: boolean;
}

export interface Invocation {
  globals: Globals;
  command: string | null;
  /** Everything after the command name (command flags, positionals, more globals). */
  tokens: string[];
}

export const GLOBAL_FLAGS = [
  {
    flag: "--host",
    placeholder: "<url>",
    description: "Platform origin (else GITTIFACTS_HOST, .gittifacts.json, the last login).",
  },
  { flag: "--human", placeholder: "", description: "Tables and sections instead of JSON." },
  {
    flag: "--json",
    placeholder: "<object|->",
    description: "Raw tool arguments as a JSON object (`-` reads stdin).",
  },
  {
    flag: "--idempotency-key",
    placeholder: "<key>",
    description: "Key for mutating commands (default: generated, printed in the output).",
  },
  {
    flag: "--help",
    placeholder: "",
    description: "Usage for a command (JSON, or text with --human).",
  },
  { flag: "--version", placeholder: "", description: "Print the CLI version." },
] as const;

const GLOBAL_VALUE_FLAGS = new Set(["--host", "--json", "--idempotency-key"]);

/** Applies a global flag; returns how many tokens it consumed (0 when `token` isn't one). */
function takeGlobal(globals: Globals, tokens: readonly string[], i: number): number {
  const token = tokens[i] ?? "";
  if (token === "--human") return set(() => (globals.human = true), 1);
  if (token === "--help" || token === "-h") return set(() => (globals.help = true), 1);
  if (token === "--version" || token === "-V") return set(() => (globals.version = true), 1);
  const eq = token.indexOf("=");
  const name = eq > 0 ? token.slice(0, eq) : token;
  if (!GLOBAL_VALUE_FLAGS.has(name)) return 0;
  let value: string | undefined;
  let used = 1;
  if (eq > 0) value = token.slice(eq + 1);
  else {
    value = tokens[i + 1];
    used = 2;
  }
  if (value === undefined) {
    throw usageError(`${name} needs a value`, {
      explanation: `Pass it as \`${name} <value>\` or \`${name}=<value>\`.`,
      command: "gittifacts help",
    });
  }
  if (name === "--host") globals.host = value;
  else if (name === "--json") globals.json = value;
  else globals.idempotencyKey = value;
  return used;
}

function set(fn: () => void, n: number): number {
  fn();
  return n;
}

/** Phase 1: global flags before the command, and the command name. */
export function splitArgv(argv: readonly string[]): Invocation {
  const globals: Globals = { human: false, help: false, version: false };
  let i = 0;
  while (i < argv.length) {
    const used = takeGlobal(globals, argv, i);
    if (used > 0) {
      i += used;
      continue;
    }
    const token = argv[i] ?? "";
    if (token.startsWith("-") && token !== "-") {
      throw usageError(`unknown flag before the command: ${token}`, {
        explanation:
          "Only global flags (--host, --human, --json, --idempotency-key, --help) may come before the command name; put command flags after it.",
        command: "gittifacts help",
      });
    }
    return { globals, command: token, tokens: argv.slice(i + 1) };
  }
  return { globals, command: null, tokens: [] };
}

export interface ParsedArgs {
  /** Flag values by property name. */
  values: Record<string, unknown>;
  positionals: string[];
  /** A lone `-` asked for the arguments on stdin. */
  stdin: boolean;
}

function helpFix(spec: CommandSpec) {
  return { explanation: `Usage: ${usageOf(spec)}`, command: `gittifacts ${spec.command} --help` };
}

function findFlag(spec: CommandSpec, name: string): FlagSpec | undefined {
  // Accept the camelCase property too (`--changeId`), so a tool's own argument names work.
  const normalized = `--${kebab(name.replace(/^--/, ""))}`;
  return spec.flags.find((f) => f.flag === normalized);
}

export function coerce(spec: CommandSpec, flag: FlagSpec, raw: string): unknown {
  const bad = (expected: string) =>
    usageError(`${flag.flag} expects ${expected}, got ${JSON.stringify(raw)}`, helpFix(spec));
  if (flag.list && raw.trimStart().startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw bad("a JSON array or one value per flag");
    }
    if (!Array.isArray(parsed)) throw bad("a JSON array");
    return parsed.map((item) =>
      coerceOne(flag, typeof item === "string" ? item : JSON.stringify(item), bad),
    );
  }
  return coerceOne(flag, raw, bad);
}

function coerceOne(flag: FlagSpec, raw: string, bad: (expected: string) => Error): unknown {
  switch (flag.kind) {
    case "string":
      return raw;
    case "integer":
      if (!/^-?\d+$/.test(raw.trim())) throw bad("an integer");
      return Number(raw);
    case "number": {
      const n = Number(raw);
      if (raw.trim() === "" || !Number.isFinite(n)) throw bad("a number");
      return n;
    }
    case "boolean": {
      const v = raw.toLowerCase();
      if (["true", "1", "yes"].includes(v)) return true;
      if (["false", "0", "no"].includes(v)) return false;
      throw bad("true or false");
    }
    case "enum": {
      const match = (flag.values ?? []).find((v) => String(v) === raw);
      if (match === undefined) throw bad(`one of ${(flag.values ?? []).map(String).join(", ")}`);
      return match;
    }
    case "json":
      try {
        return JSON.parse(raw);
      } catch {
        throw bad("JSON (quote it for the shell, e.g. '{\"a\":1}')");
      }
  }
}

/** Phase 2: the command's flags (globals may still appear and are applied to `globals`). */
export function parseCommandTokens(
  spec: CommandSpec,
  tokens: readonly string[],
  globals: Globals,
): ParsedArgs {
  const values: Record<string, unknown> = {};
  const positionals: string[] = [];
  let stdin = false;
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i] ?? "";
    if (token === "--") {
      positionals.push(...tokens.slice(i + 1));
      break;
    }
    if (token === "-") {
      stdin = true;
      i += 1;
      continue;
    }
    const used = takeGlobal(globals, tokens, i);
    if (used > 0) {
      i += used;
      continue;
    }
    if (!token.startsWith("-")) {
      positionals.push(token);
      i += 1;
      continue;
    }
    const eq = token.indexOf("=");
    const name = eq > 0 ? token.slice(0, eq) : token;
    let flag = findFlag(spec, name);
    let negated = false;
    if (!flag && name.startsWith("--no-")) {
      const positive = findFlag(spec, `--${name.slice(5)}`);
      if (positive?.kind === "boolean") {
        flag = positive;
        negated = true;
      }
    }
    if (!flag) {
      const near = suggest(
        name,
        spec.flags.map((f) => f.flag),
      );
      throw usageError(
        `unknown flag for ${spec.command}: ${name}${near.length ? ` (did you mean ${near.join(", ")}?)` : ""}`,
        helpFix(spec),
        { flags: spec.flags.map((f) => f.flag) },
      );
    }
    if (flag.kind === "boolean" && !flag.list) {
      values[flag.property] = negated
        ? false
        : eq > 0
          ? coerce(spec, flag, token.slice(eq + 1))
          : true;
      i += 1;
      continue;
    }
    let raw: string | undefined;
    if (eq > 0) {
      raw = token.slice(eq + 1);
      i += 1;
    } else {
      raw = tokens[i + 1];
      if (raw === undefined || (raw.startsWith("--") && raw.length > 2)) {
        throw usageError(`${flag.flag} needs a value`, helpFix(spec));
      }
      i += 2;
    }
    const v = coerce(spec, flag, raw);
    if (flag.list) {
      const prev = values[flag.property];
      const acc = Array.isArray(prev) ? prev : [];
      values[flag.property] = acc.concat(Array.isArray(v) ? v : [v]);
    } else {
      values[flag.property] = v;
    }
  }
  return { values, positionals, stdin };
}

function parseObject(text: string, source: string, spec: CommandSpec): Record<string, unknown> {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (e) {
    throw usageError(
      `${source} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
      helpFix(spec),
    );
  }
  if (!isRecord(v)) {
    throw usageError(`${source} must be a JSON object of tool arguments`, helpFix(spec));
  }
  return v;
}

/**
 * Merges stdin JSON, `--json`, the positional and the flags into the tool's arguments, and checks
 * required properties before anything is sent.
 */
export function buildToolArgs(
  spec: CommandSpec,
  parsed: ParsedArgs,
  globals: Globals,
  stdinText: string | null,
): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const needsStdin = parsed.stdin || globals.json === "-";
  if (needsStdin && stdinText === null) {
    throw usageError("expected JSON arguments on stdin", helpFix(spec));
  }
  if (parsed.stdin && stdinText !== null)
    Object.assign(args, parseObject(stdinText, "stdin", spec));
  if (globals.json !== undefined) {
    const text = globals.json === "-" ? (stdinText ?? "") : globals.json;
    Object.assign(args, parseObject(text, "--json", spec));
  }
  if (parsed.positionals.length > 0) {
    const flag = spec.flags.find((f) => f.property === spec.positional);
    if (!flag || parsed.positionals.length > 1) {
      throw usageError(
        `unexpected argument${parsed.positionals.length > 1 ? "s" : ""}: ${parsed.positionals.join(" ")}`,
        helpFix(spec),
      );
    }
    args[flag.property] = coerce(spec, flag, parsed.positionals[0] ?? "");
  }
  Object.assign(args, parsed.values);
  const missing = (spec.inputSchema.required ?? []).filter(
    (p) => p !== IDEMPOTENCY_PROPERTY && args[p] === undefined,
  );
  if (missing.length > 0) {
    const flags = missing.map((p) => {
      const flag = spec.flags.find((f) => f.property === p)?.flag ?? `--${kebab(p)}`;
      return p === spec.positional ? `<${p}> (or ${flag})` : flag;
    });
    throw usageError(`missing required ${flags.join(", ")}`, helpFix(spec), { missing });
  }
  return args;
}
