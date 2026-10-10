/**
 * MCP tool reference, from `buildTools()` in @app/mcp: the same objects the server registers
 * (names, titles, descriptions, JSON Schemas, annotations). Required scopes are read from the
 * handlers' `requireScope(caller, "…")` calls in the tool sources.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCall } from "@app/conventions";
import { exampleCall, INSTRUCTIONS, SERVER_INFO } from "@app/mcp";
import { commandName } from "gittifacts/src/tools/commands.js";
import { validateSample } from "../src/check/validate.js";
import {
  join as blocks,
  cell,
  code,
  fence,
  firstSentence,
  type GeneratedPage,
  header,
  table,
} from "./lib/md.js";
import { fieldRows, type JsonSchema, typeOf } from "./lib/schema.js";
import { mcpTools, type ToolDef } from "./lib/tools.js";

const REPO = join(import.meta.dirname, "..", "..", "..");
const TOOL_SOURCES = [
  "tools.ts",
  "tools/plans.ts",
  "tools/changes.ts",
  "tools/workspace.ts",
  "tools/import.ts",
  "tools/queue.ts",
].map((f) => join(REPO, "packages/mcp/src", f));

/** Scopes each tool's handler checks, in source order. */
export function toolScopes(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const file of TOOL_SOURCES) {
    const src = readFileSync(file, "utf8");
    const names = [...src.matchAll(/name: "([a-z_]+)"/g)];
    names.forEach((m, i) => {
      const end = names[i + 1]?.index ?? src.length;
      const body = src.slice(m.index ?? 0, end);
      const scopes = [...body.matchAll(/requireScope\(caller, "([a-z:]+)"\)/g)].map(
        (s) => s[1] ?? "",
      );
      const prev = out.get(m[1] ?? "") ?? [];
      out.set(m[1] ?? "", [...new Set([...prev, ...scopes])]);
    });
  }
  return out;
}

export const FAMILIES: readonly {
  file: string;
  title: string;
  nav: string;
  description: string;
  tools: readonly string[];
}[] = [
  {
    file: "reference/mcp-projects.md",
    title: "MCP tools: projects and discovery",
    nav: "MCP: projects",
    description:
      "create_project, whoami, list_repos, list_members, propose_platform_config and search_tools: arguments, scopes, examples and outputs.",
    tools: [
      "create_project",
      "whoami",
      "list_repos",
      "list_members",
      "propose_platform_config",
      "search_tools",
    ],
  },
  {
    file: "reference/mcp-changes.md",
    title: "MCP tools: plans and changes",
    nav: "MCP: plans and changes",
    description:
      "create_plan, get_plan, list_plans, withdraw_plan, start_change, list_changes, wait_for_change and the read tools for status, evidence, tours and issues: arguments, scopes, examples and outputs.",
    tools: [
      "create_plan",
      "get_plan",
      "list_plans",
      "withdraw_plan",
      "start_change",
      "list_changes",
      "refresh_push_token",
      "wait_for_change",
      "get_change_status",
      "get_evidence",
      "get_tour",
      "request_review",
      "list_issues_for_change",
    ],
  },
  {
    file: "reference/mcp-workspaces.md",
    title: "MCP tools: remote workspaces",
    nav: "MCP: workspaces",
    description:
      "open_workspace and the ws_* tools for agents without a shell: arguments, scopes, examples and outputs.",
    tools: [
      "open_workspace",
      "ws_exec",
      "ws_read",
      "ws_write",
      "ws_diff",
      "ws_commit_push",
      "close_workspace",
    ],
  },
  {
    file: "reference/mcp-merge-queue.md",
    title: "MCP tools: merge queue",
    nav: "MCP: merge queue",
    description:
      "enqueue, queue_status, wait_for_merge, dequeue, reprioritize and queue_overview: arguments, scopes, examples and outputs.",
    tools: [
      "enqueue",
      "queue_status",
      "wait_for_merge",
      "dequeue",
      "reprioritize",
      "queue_overview",
    ],
  },
];

/** A value that satisfies `s`, with `<name>` placeholders for strings. */
function sampleValue(name: string, s: JsonSchema | undefined): unknown {
  if (s?.enum !== undefined) return s.enum[0];
  const t = Array.isArray(s?.type) ? s?.type[0] : s?.type;
  if (t === "array") return [sampleValue(name.replace(/s$/, ""), s?.items)];
  if (t === "integer" || t === "number") return s?.minimum ?? 1;
  if (t === "boolean") return true;
  if (t === "object") return {};
  return `<${name}>`;
}

/** The tool's own example (search_tools shows it) when it is valid, else one built from the schema. */
export function exampleFor(t: ToolDef): string {
  const own = exampleCall(t.name, t.inputSchema);
  const parsed = parseCall(own);
  if (
    parsed !== null &&
    parsed.tool === t.name &&
    validateSample(t.inputSchema as object, parsed.args).length === 0
  ) {
    return own;
  }
  const s = t.inputSchema as JsonSchema;
  const required = s.required ?? [];
  // No required arguments: show the first enum-valued one (create_project's template).
  const keys =
    required.length > 0
      ? required
      : Object.entries(s.properties ?? {})
          .filter(([, p]) => p.enum !== undefined)
          .slice(0, 1)
          .map(([k]) => k);
  const args = keys.map((r) => `${r}: ${JSON.stringify(sampleValue(r, s.properties?.[r]))}`);
  return `${t.name}({${args.length === 0 ? "" : ` ${args.join(", ")} `}})`;
}

function toolSection(t: ToolDef, scopes: readonly string[]): string {
  const input = t.inputSchema as JsonSchema;
  const rows = fieldRows(input)
    .filter((r) => r.path !== "idempotencyKey")
    .map((r) => [
      code(r.path),
      cell(r.type),
      r.required ? "yes" : "",
      cell([r.description, r.constraints].filter(Boolean).join(" ")),
    ]);
  const readOnly = t.annotations?.readOnlyHint === true;
  const idem = input.properties?.idempotencyKey !== undefined;
  const meta = [
    `**Scope:** ${scopes.length === 0 ? "none" : scopes.map(code).join(" + ")}`,
    `**Kind:** ${readOnly ? "read-only" : `mutating${idem ? " (retry safely with `idempotencyKey`)" : ""}`}`,
    `**CLI:** ${code(`gittifacts ${commandName(t.name)}`)}`,
  ].join(" · ");
  const out = t.outputSchema as JsonSchema | undefined;
  const outFields = Object.entries(out?.properties ?? {}).map(
    ([k, v]) => `${code(k)} (${typeOf(v)})`,
  );
  return blocks(
    `## \`${t.name}\``,
    t.description ?? t.title ?? "",
    meta,
    rows.length === 0 ? "No arguments." : table(["Argument", "Type", "Required", "Notes"], rows),
    fence("text", exampleFor(t)),
    outFields.length === 0 ? "" : `**Returns:** ${outFields.join(", ")}.`,
  );
}

export function generateMcp(): GeneratedPage[] {
  const tools = mcpTools();
  const scopes = toolScopes();
  const sources = ["packages/mcp/src/tools.ts", "packages/mcp/src/tools/*.ts"];
  const pages: GeneratedPage[] = FAMILIES.map((f, i) => ({
    file: f.file,
    content: blocks(
      header(
        {
          title: f.title,
          nav: f.nav,
          description: f.description,
          order: 11 + i,
          audience: "agents",
        },
        sources,
      ),
      ...f.tools.flatMap((name) => {
        const t = tools.find((x) => x.name === name);
        return t === undefined ? [] : [toolSection(t, scopes.get(name) ?? [])];
      }),
    ),
  }));
  const assigned = new Set(FAMILIES.flatMap((f) => f.tools));
  const others = tools.filter((t) => !assigned.has(t.name));
  const familyOf = (name: string) => FAMILIES.find((f) => f.tools.includes(name));
  const rows = tools.map((t) => {
    const f = familyOf(t.name);
    const href = f ? `/docs/${f.file.replace(/\.md$/, "")}#${t.name}` : `#${t.name}`;
    return [
      `[${code(t.name)}](${href})`,
      cell(firstSentence(t.description ?? "")),
      (scopes.get(t.name) ?? []).map(code).join(" "),
      t.annotations?.readOnlyHint === true ? "read" : "write",
    ];
  });
  pages.unshift({
    file: "reference/mcp-tools.md",
    content: blocks(
      header(
        {
          title: "MCP tools",
          description: `All ${tools.length} tools of the gittifacts MCP server: what each does, the scope it needs, and where its arguments are documented.`,
          order: 10,
          audience: "agents",
        },
        [...sources, "packages/mcp/src/server.ts"],
      ),
      `Server \`${SERVER_INFO.name}\` ${SERVER_INFO.version} at \`https://<host>/mcp\` (streamable HTTP, stateless). Send \`Authorization: Bearer <token>\` on every request; see [Authenticate](/docs/guides/authenticate). Errors come back as a tool error whose text is \`{ "error": { "code", "message", "fix" } }\` ([error codes](/docs/reference/errors)).`,
      "The server's own instructions, sent on `initialize`:",
      fence("text verbatim", INSTRUCTIONS),
      table(["Tool", "What it does", "Scope", "Kind"], rows),
      ...others.map((t) => toolSection(t, scopes.get(t.name) ?? [])),
    ),
  });
  return pages;
}
