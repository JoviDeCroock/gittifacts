import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
// Test-only reach into @app/mcp: the live tool list is the truth TOOL_NAMES must match.
import { buildTools, type McpBackend } from "../../mcp/src/index.js";
import { isToolName, parseCall } from "../src/index.js";

export const PACKAGE_DIR = join(import.meta.dirname, "..");
export const REPO_ROOT = join(PACKAGE_DIR, "..", "..");
export const TEMPLATES_DIR = join(REPO_ROOT, "templates");

export const HOST = "https://gittifacts.example";
export const MCP_URL = `${HOST}/mcp`;

/** Every `tool_name({...})` call in inline code spans of a markdown/text document. */
export function callsIn(text: string): string[] {
  return [...text.matchAll(/`([a-z][a-z0-9_]*\(\{[^`]*\}\))`/g)].map((m) => m[1] ?? "");
}

const inert = new Proxy(
  {},
  { get: () => () => Promise.reject(new Error("handlers are never called here")) },
) as McpBackend;

/** The tools the MCP server registers (`tools/list`), read from `buildTools()`. */
export const LIVE_TOOL_NAMES: ReadonlySet<string> = new Set(
  Object.values(buildTools(inert)).map((t) => t.name),
);

/** Asserts a call string parses and names a tool the MCP server really registers. */
export function expectValidCall(text: string): void {
  const parsed = parseCall(text);
  expect(parsed, `does not parse as tool_name({...}): ${text}`).not.toBeNull();
  expect(isToolName(parsed?.tool ?? ""), `unknown tool in: ${text}`).toBe(true);
  expect(LIVE_TOOL_NAMES.has(parsed?.tool ?? ""), `not an MCP tool in: ${text}`).toBe(true);
}

export function readText(path: string): string {
  return readFileSync(path, "utf8");
}

export function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? listFiles(join(dir, e.name)) : [join(dir, e.name)],
  );
}
