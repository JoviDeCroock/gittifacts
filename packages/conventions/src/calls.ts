/**
 * MCP tool names the conventions refer to, and the `tool_name({ ... })` call notation used in
 * `NextStep.call` / `ErrorFix.call`. `@app/mcp` should register exactly these names; the tests
 * here fail if any generated text calls a tool that isn't listed.
 */

export const TOOL_NAMES = [
  // onboarding
  "create_project",
  "whoami",
  "capabilities",
  "search_tools",
  // plans and changes
  "list_repos",
  "create_plan",
  "start_change",
  "wait_for_change",
  "get_change_status",
  "get_evidence",
  "get_tour",
  "request_review",
  "list_issues_for_change",
  // remote workspaces (agents without a shell)
  "open_workspace",
  "ws_exec",
  "ws_read",
  "ws_write",
  "ws_diff",
  "ws_commit_push",
  "close_workspace",
  // imported repos
  "propose_platform_config",
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export function isToolName(name: string): name is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(name);
}

export type CallValue =
  | string
  | number
  | boolean
  | null
  | readonly CallValue[]
  | { readonly [key: string]: CallValue };
export type CallArgs = { readonly [key: string]: CallValue | undefined };

const IDENT = /^[A-Za-z_$][\w$]*$/;

function formatValue(value: CallValue): string {
  if (Array.isArray(value)) return `[${value.map((v: CallValue) => formatValue(v)).join(", ")}]`;
  if (value !== null && typeof value === "object") return formatObject(value as CallArgs);
  return JSON.stringify(value);
}

function formatObject(args: CallArgs): string {
  const entries = Object.entries(args).filter((e): e is [string, CallValue] => e[1] !== undefined);
  if (entries.length === 0) return "{}";
  const body = entries
    .map(([key, value]) => `${IDENT.test(key) ? key : JSON.stringify(key)}: ${formatValue(value)}`)
    .join(", ");
  return `{ ${body} }`;
}

/**
 * `call("start_change", { planId: "pln_1" })` → `start_change({ planId: "pln_1" })`.
 * Keys are bare identifiers, values are JSON. `undefined` values are dropped.
 */
export function call(tool: ToolName, args: CallArgs = {}): string {
  return `${tool}(${formatObject(args)})`;
}

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

/** Parses `tool_name({ ... })` (the notation `call()` produces). Returns null when malformed. */
export function parseCall(text: string): ParsedCall | null {
  const match = /^([a-z][a-z0-9_]*)\((\{[\s\S]*\})\)$/.exec(text.trim());
  if (match === null) return null;
  const [, tool, body] = match;
  if (tool === undefined || body === undefined) return null;
  try {
    const args: unknown = JSON.parse(quoteKeys(body));
    if (typeof args !== "object" || args === null || Array.isArray(args)) return null;
    return { tool, args: args as Record<string, unknown> };
  } catch {
    return null;
  }
}

/** `<changeId>`-style placeholder used when a concrete id isn't known. */
export function placeholder(name: string): string {
  return `<${name}>`;
}
