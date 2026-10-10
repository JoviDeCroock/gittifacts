/**
 * A small CSS walker for the design-rules test: every declaration with the selector (or at-rule
 * chain) it sits under. Enough for hand-written stylesheets; not a general parser.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

export interface Decl {
  file: string;
  line: number;
  /** Innermost selector or at-rule prelude, e.g. `.topbar[data-scrolled="true"]`. */
  selector: string;
  /** Every enclosing prelude, outermost first (`@media (…)`, then the selector). */
  context: string[];
  property: string;
  value: string;
}

export function cssFiles(dir: string, root: string = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...cssFiles(p, root));
    else if (entry.name.endsWith(".css")) out.push(p);
  }
  return out.sort();
}

export function declarations(path: string, label = path): Decl[] {
  const src = readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
  const out: Decl[] = [];
  const stack: string[] = [];
  let buf = "";
  let bufStart = 0;
  let depthParen = 0;
  const lineAt = (i: number) => src.slice(0, i).split("\n").length;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === "(") depthParen++;
    if (ch === ")") depthParen--;
    if (ch === "{" && depthParen === 0) {
      stack.push(buf.trim().replace(/\s+/g, " "));
      buf = "";
      bufStart = i + 1;
    } else if ((ch === ";" || ch === "}") && depthParen === 0) {
      const text = buf.trim();
      const colon = text.indexOf(":");
      if (text && colon > 0 && !text.startsWith("@")) {
        const lead = buf.length - buf.trimStart().length;
        out.push({
          file: label,
          line: lineAt(bufStart + lead),
          selector: stack[stack.length - 1] ?? "",
          context: [...stack],
          property: text.slice(0, colon).trim().toLowerCase(),
          value: text.slice(colon + 1).trim().replace(/\s+/g, " "),
        });
      }
      buf = "";
      bufStart = i + 1;
      if (ch === "}") stack.pop();
    } else {
      if (!buf) bufStart = i;
      buf += ch;
    }
  }
  return out;
}

/** Splits a value at top-level commas (not the ones inside `cubic-bezier(…)` or `var(…)`). */
export function topLevelItems(value: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of value) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      items.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) items.push(cur.trim());
  return items;
}

export function rel(root: string, p: string): string {
  return relative(root, p).replaceAll("\\", "/");
}
