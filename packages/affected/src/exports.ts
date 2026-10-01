/**
 * A cheap exported-symbol surface for one module, without a type checker: exported name →
 * normalized declaration text with function bodies replaced by `{}`. Comments and whitespace do
 * not matter; a changed body does not matter; a changed signature, type, class member, constant
 * value or re-export does. It errs towards "changed" (a constant's initializer, an object
 * literal's values), never towards "unchanged".
 */
import { type Token, tokenize } from "./scan.js";

const DECL_KEYWORDS = new Set([
  "function",
  "class",
  "const",
  "let",
  "var",
  "interface",
  "type",
  "enum",
  "namespace",
  "module",
]);
const MODIFIERS = new Set(["declare", "abstract", "async", "default", "export"]);
const STATEMENT_START = new Set([
  "export",
  "import",
  "const",
  "let",
  "var",
  "function",
  "class",
  "interface",
  "type",
  "enum",
  "declare",
  "abstract",
  "namespace",
]);
/** A `{` after one of these is a type/object literal, not a function body. */
const TYPE_CONTEXT = new Set([
  ":",
  "|",
  "&",
  "<",
  ",",
  "(",
  "=",
  "=>",
  "?",
  "[",
  "keyof",
  "typeof",
  "extends",
  "in",
  "readonly",
]);

interface Depthed {
  tokens: Token[];
  depth: number[];
}

function withDepth(src: string): Depthed {
  const { tokens } = tokenize(src);
  const depth: number[] = new Array(tokens.length);
  let d = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as Token;
    if (t.k === "p" && (t.v === "}" || t.v === ")" || t.v === "]")) d = Math.max(0, d - 1);
    else if (t.k === "tpl" && t.tp === "tail") d = Math.max(0, d - 1);
    depth[i] = d;
    if (t.k === "p" && (t.v === "{" || t.v === "(" || t.v === "[")) d++;
    else if (t.k === "tpl" && t.tp === "head") d++;
  }
  return { tokens, depth };
}

/** Index of the token matching the opener at `open` (or the last token). */
function matching(dt: Depthed, open: number): number {
  const base = dt.depth[open] ?? 0;
  for (let j = open + 1; j < dt.tokens.length; j++) {
    if ((dt.depth[j] ?? 0) === base) {
      const t = dt.tokens[j] as Token;
      if (t.k === "p" && (t.v === "}" || t.v === ")" || t.v === "]")) return j;
    }
  }
  return dt.tokens.length - 1;
}

/** Index after the statement starting at `start` (exclusive end). */
function statementEnd(dt: Depthed, start: number): number {
  const base = dt.depth[start] ?? 0;
  for (let j = start + 1; j < dt.tokens.length; j++) {
    const d = dt.depth[j] ?? 0;
    if (d < base) return j;
    if (d !== base) continue;
    const t = dt.tokens[j] as Token;
    if (t.k === "p" && t.v === ";") return j + 1;
    if (t.nl && t.k === "id" && STATEMENT_START.has(t.v)) {
      const prev = dt.tokens[j - 1];
      // `type` inside `export type X = …` continuation lines is not a new statement unless it
      // starts a declaration; operators at the end of the previous line continue it.
      if (prev !== undefined && prev.k === "p" && /^[=|&,(<:?+\-*/.]$|^=>$/.test(prev.v)) continue;
      return j;
    }
    if (t.nl && t.k === "p" && t.v === "@") return j;
  }
  return dt.tokens.length;
}

/** Token texts of [from, to) with function bodies replaced by `{}`. */
function signatureText(dt: Depthed, from: number, to: number): string {
  const out: string[] = [];
  let afterParams = false;
  for (let j = from; j < to; j++) {
    const t = dt.tokens[j] as Token;
    if (t.k === "p" && t.v === "{") {
      const prev = dt.tokens[j - 1];
      const prevText = prev === undefined ? "" : prev.v;
      const isBody =
        prevText === "=>" ||
        prevText === ")" ||
        (afterParams && !(prev !== undefined && TYPE_CONTEXT.has(prevText)));
      if (isBody) {
        out.push("{}");
        j = matching(dt, j);
        afterParams = false;
        continue;
      }
    }
    if (t.k === "p" && t.v === ")") afterParams = true;
    else if (t.k === "p" && (t.v === ";" || t.v === "," || t.v === "=")) afterParams = false;
    out.push(t.k === "str" ? JSON.stringify(t.v) : t.k === "tpl" ? `\`${t.v}\`` : t.v);
  }
  return out.join(" ");
}

/** Declared name of the declaration at `i` (after modifiers), or null. */
function declName(dt: Depthed, i: number): { name: string | null; keyword: string | null } {
  let j = i;
  while (j < dt.tokens.length && MODIFIERS.has(dt.tokens[j]?.v ?? "") && dt.tokens[j]?.k === "id")
    j++;
  const kw = dt.tokens[j];
  if (kw === undefined || kw.k !== "id" || !DECL_KEYWORDS.has(kw.v))
    return { name: null, keyword: null };
  let n = j + 1;
  if (dt.tokens[n]?.v === "*") n++; // function*
  if (kw.v === "const" && dt.tokens[n]?.v === "enum") n++;
  const name = dt.tokens[n];
  if (name !== undefined && name.k === "id") return { name: name.v, keyword: kw.v };
  return { name: null, keyword: kw.v };
}

export type ExportSurface = Map<string, string>;

/** Exported name → signature text (re-exports keyed by their source). */
export function exportSurface(src: string): ExportSurface {
  const dt = withDepth(src);
  const { tokens, depth } = dt;
  const surface: ExportSurface = new Map();
  const add = (name: string, text: string): void => {
    const prev = surface.get(name);
    surface.set(name, prev === undefined ? text : `${prev} ;; ${text}`);
  };

  // Top-level declarations by name, for `export { a, b as c }`.
  const locals = new Map<string, string>();
  for (let i = 0; i < tokens.length; i++) {
    if (depth[i] !== 0) continue;
    const t = tokens[i] as Token;
    if (
      t.k !== "id" ||
      !(DECL_KEYWORDS.has(t.v) || t.v === "declare" || t.v === "abstract" || t.v === "async")
    )
      continue;
    if (
      tokens[i - 1]?.v === "export" ||
      (tokens[i - 1]?.k === "id" && MODIFIERS.has(tokens[i - 1]?.v ?? ""))
    )
      continue;
    const { name } = declName(dt, i);
    if (name === null) continue;
    const end = statementEnd(dt, i);
    const prev = locals.get(name);
    const text = signatureText(dt, i, end);
    locals.set(name, prev === undefined ? text : `${prev} ;; ${text}`);
  }

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as Token;
    if (depth[i] !== 0 || t.k !== "id" || t.v !== "export") continue;
    const prev = tokens[i - 1];
    if (prev !== undefined && prev.k === "p" && (prev.v === "." || prev.v === "?.")) continue;
    const next = tokens[i + 1];
    if (next === undefined) break;
    const end = statementEnd(dt, i);
    const text = signatureText(dt, i, end);
    let k = i + 1;
    if (
      next.k === "id" &&
      next.v === "type" &&
      (tokens[i + 2]?.v === "{" || tokens[i + 2]?.v === "*")
    )
      k = i + 2;
    const head = tokens[k] as Token;
    if (head.k === "p" && (head.v === "*" || head.v === "{")) {
      // Re-export (`… from "x"`) or a local export list.
      const close = head.v === "{" ? matching(dt, k) : k;
      const from = tokens[close + 1];
      if (from?.k === "id" && from.v === "from") {
        add(`from:${tokens[close + 2]?.v ?? ""}:${text}`, text);
      } else if (head.v === "{") {
        // export { a, b as c }
        let j = k + 1;
        while (j < close) {
          const local = tokens[j];
          if (local === undefined || local.k !== "id") {
            j++;
            continue;
          }
          let localName = local.v;
          let isType = false;
          if (localName === "type" && tokens[j + 1]?.k === "id" && tokens[j + 1]?.v !== "as") {
            isType = true;
            j++;
            localName = tokens[j]?.v ?? localName;
          }
          let exported = localName;
          if (tokens[j + 1]?.v === "as") {
            exported = tokens[j + 2]?.v ?? exported;
            j += 2;
          }
          add(
            exported,
            `${isType ? "type " : ""}${locals.get(localName) ?? `binding ${localName}`}`,
          );
          j++;
          while (j < close && tokens[j]?.v !== ",") j++;
          j++;
        }
      }
      i = end - 1;
      continue;
    }
    if (next.k === "id" && next.v === "default") {
      add("default", text);
    } else if (next.k === "p" && next.v === "=") {
      add("export=", text);
    } else if (next.k === "id" && next.v === "as") {
      add("export-as-namespace", text);
    } else if (next.k === "id" && next.v === "import") {
      add(tokens[i + 2]?.v ?? "import", text);
    } else {
      const { name } = declName(dt, i + 1);
      add(name ?? text, text);
    }
    i = end - 1;
  }
  return surface;
}

/** Do two module versions export the same surface? */
export function sameSurface(a: ExportSurface, b: ExportSurface): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}
