import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
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

/** Asserts a call string parses and names a known tool. */
export function expectValidCall(text: string): void {
  const parsed = parseCall(text);
  expect(parsed, `does not parse as tool_name({...}): ${text}`).not.toBeNull();
  expect(isToolName(parsed?.tool ?? ""), `unknown tool in: ${text}`).toBe(true);
}

export function readText(path: string): string {
  return readFileSync(path, "utf8");
}

export function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? listFiles(join(dir, e.name)) : [join(dir, e.name)],
  );
}
