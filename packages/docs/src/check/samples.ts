/**
 * Sample checks: every `tool_name({...})` call parses and names a real MCP tool with arguments
 * that satisfy its input schema; every `gittifacts …` command uses real commands and flags (the
 * CLI's own parser decides); every JSON block parses, and validates when it names a schema.
 */
import { parseCall, TOOL_NAMES } from "@app/conventions";
import { ApiError, RepoPolicy } from "@app/domain";
import { EvidenceItem } from "@app/evidence";
import { parseCommandTokens, splitArgv } from "gittifacts/src/args.js";
import { BUILTINS } from "gittifacts/src/main.js";
import { type CommandSpec, findCommand } from "gittifacts/src/tools/commands.js";
import type { ZodType } from "zod";
import { mcpTools } from "../../generate/lib/tools.js";
import type { Page } from "../content.js";
import type { Extracted } from "./extract.js";
import type { Problem } from "./problem.js";
import { validateSample } from "./validate.js";

const SHELL = new Set(["sh", "bash", "shell", "console", "zsh"]);

/** `name({` candidates: snake_case identifiers or a known tool name, not a method call. */
const CALL_START = /(?<![.\w$])([a-z][a-z0-9_]*)\(\{/g;

/** The text from `(` to its matching `)`, respecting strings. */
function balanced(text: string, open: number): string | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (quote !== null) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return text.slice(open, i + 1);
  }
  return null;
}

export function checkToolCalls(page: Page, text: string, line: number): Problem[] {
  const tools = mcpTools();
  const names = new Set(tools.map((t) => t.name));
  // Names the conventions refer to count as calls too, so a name the server lacks is caught.
  const referenced = new Set<string>(TOOL_NAMES);
  const problems: Problem[] = [];
  for (const m of text.matchAll(CALL_START)) {
    const name = m[1] ?? "";
    if (!names.has(name) && !referenced.has(name) && !name.includes("_")) continue;
    const at = (m.index ?? 0) + name.length;
    const args = balanced(text, at);
    const where = { file: page.file, line, rule: "tool-call" as const };
    if (!names.has(name)) {
      problems.push({ ...where, message: `${name}(…) is not an MCP tool` });
      continue;
    }
    const parsed = args === null ? null : parseCall(`${name}${args}`);
    if (parsed === null) {
      problems.push({
        ...where,
        message: `${name}${args ?? "(…"} does not parse (keys bare, values JSON)`,
      });
      continue;
    }
    const tool = tools.find((t) => t.name === name);
    for (const e of validateSample(tool?.inputSchema as object, parsed.args)) {
      problems.push({ ...where, message: `${name}: ${e.path} ${e.message}` });
    }
  }
  return problems;
}

/** Shell words of one command line (quotes and backslash escapes, no expansion). */
export function shellWords(line: string): string[] {
  const words: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let has = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] ?? "";
    if (quote !== null) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < line.length) cur += line[++i];
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      has = true;
    } else if (ch === "\\" && i + 1 < line.length) {
      cur += line[++i];
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur !== "") words.push(cur);
      cur = "";
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (has || cur !== "") words.push(cur);
  return words;
}

/**
 * Validates one `gittifacts …` invocation (argv after the program name). `strict` also requires
 * every required argument (runnable samples); inline mentions only need real commands and flags.
 */
export function cliProblem(argv: readonly string[], strict = true): string | null {
  try {
    const inv = splitArgv(argv);
    if (inv.command === null) return null;
    // `gittifacts <command> --help` names no command: a placeholder, not a typo.
    if (!strict && /^<[^<>]+>$/.test(inv.command)) return null;
    const builtin = BUILTINS.find((b) => b.spec.command === inv.command);
    const spec: CommandSpec | undefined = builtin?.spec ?? findCommand(inv.command);
    if (spec === undefined) return `unknown command: gittifacts ${inv.command}`;
    const parsed = parseCommandTokens(spec, inv.tokens, inv.globals);
    if (!strict || inv.globals.help || inv.globals.json !== undefined || parsed.stdin) return null;
    const positional = spec.flags.find((f) => f.property === spec.positional);
    if (parsed.positionals.length > (positional ? 1 : 0) && spec.command !== "search-tools") {
      return `gittifacts ${spec.command}: unexpected argument ${parsed.positionals.at(-1)}`;
    }
    for (const f of spec.flags) {
      const given =
        f.property in parsed.values || (f === positional && parsed.positionals.length > 0);
      if (f.required && !given) return `gittifacts ${spec.command}: missing required ${f.flag}`;
    }
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** The CLI tarball the platform serves (`npx -y https://<host>/cli/v2/gittifacts.tgz …`). */
const CLI_TARBALL = /^https?:\/\/[^\s/]+\/cli\/(?:v\d+\/)?gittifacts(-[\w.-]+)?\.tgz$/;

/**
 * Where the CLI's own argv starts in a command's words: after `gittifacts`, `npx gittifacts`, or
 * `npx -y <tarball URL>`; -1 when the command is not the CLI.
 */
export function cliArgvStart(words: readonly string[]): number {
  if (words[0] === "gittifacts") return 1;
  if (words[0] !== "npx") return -1;
  let i = 1;
  while (words[i] === "-y" || words[i] === "--yes") i++;
  const pkg = words[i] ?? "";
  return pkg === "gittifacts" || CLI_TARBALL.test(pkg) ? i + 1 : -1;
}

/** `gittifacts …`, `npx gittifacts …` and `npx -y <tarball> …` segments of a shell snippet. */
export function checkCommands(page: Page, text: string, line: number, strict = true): Problem[] {
  const problems: Problem[] = [];
  const logical = text.replace(/\\\n\s*/g, " ").split("\n");
  for (const raw of logical) {
    const cmd = raw.replace(/^\s*\$\s+/, "").replace(/(^|\s)#.*$/, "");
    for (const segment of cmd.split(/&&|\|\||;|\|/)) {
      const words = shellWords(segment.trim());
      const start = cliArgvStart(words);
      if (start < 0) continue;
      const problem = cliProblem(words.slice(start), strict);
      if (problem !== null) problems.push({ file: page.file, line, rule: "cli", message: problem });
    }
  }
  return problems;
}

const ZOD_SCHEMAS: Record<string, ZodType> = {
  policy: RepoPolicy,
  "evidence-item": EvidenceItem,
  error: ApiError,
};

function jsonSchemaFor(name: string): object | ZodType | null {
  const zod = ZOD_SCHEMAS[name];
  if (zod !== undefined) return zod;
  const m = /^tool:([a-z_]+):(input|output)$/.exec(name);
  const tool = m === null ? undefined : mcpTools().find((t) => t.name === m[1]);
  if (tool === undefined) return null;
  return (m?.[2] === "input" ? tool.inputSchema : tool.outputSchema) as object;
}

export function checkJson(
  page: Page,
  text: string,
  info: readonly string[],
  line: number,
): Problem[] {
  const where = { file: page.file, line, rule: "json" as const };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    return [
      {
        ...where,
        message: `invalid JSON (use \`jsonc\` or \`text\` for illustrations): ${e instanceof Error ? e.message : e}`,
      },
    ];
  }
  const name = info.find((i) => i.startsWith("schema="))?.slice("schema=".length);
  if (name === undefined) return [];
  const schema = jsonSchemaFor(name);
  if (schema === null) return [{ ...where, message: `unknown schema "${name}"` }];
  if ("safeParse" in schema && typeof schema.safeParse === "function") {
    const r = (schema as ZodType).safeParse(value);
    return r.success
      ? []
      : r.error.issues.map((i) => ({
          ...where,
          message: `${name}: ${i.path.join(".") || "(root)"} ${i.message}`,
        }));
  }
  return validateSample(schema, value).map((e) => ({
    ...where,
    message: `${name}: ${e.path} ${e.message}`,
  }));
}

function jsonStrings(text: string): string[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return [text];
  }
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v !== null && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(value);
  return out;
}

export function checkSamples(page: Page, x: Extracted): Problem[] {
  const problems: Problem[] = [];
  for (const b of x.blocks) {
    if (b.info.includes("verbatim")) continue;
    if (b.lang === "json" || b.lang === "jsonc") {
      // Calls inside JSON samples live in strings: check the decoded strings.
      for (const str of jsonStrings(b.text)) problems.push(...checkToolCalls(page, str, b.line));
    } else {
      problems.push(...checkToolCalls(page, b.text, b.line));
    }
    if (SHELL.has(b.lang)) problems.push(...checkCommands(page, b.text, b.line));
    if (b.lang === "json") problems.push(...checkJson(page, b.text, b.info, b.line));
  }
  for (const c of x.inline) {
    problems.push(...checkToolCalls(page, c.text, c.line));
    // Inline mentions name commands; usage notation (`[--flag <x>]`) is not an invocation.
    if (/^(npx (-y )?)?(gittifacts|\S+\/cli\/(?:v\d+\/)?gittifacts\S*\.tgz) /.test(c.text) && !c.text.includes("[")) {
      problems.push(...checkCommands(page, c.text, c.line, false));
    }
  }
  return problems;
}
