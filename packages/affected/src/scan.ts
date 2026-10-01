/**
 * A fast, tolerant scanner for JS/TS module references. No TypeScript compiler: a single-pass
 * tokenizer that understands comments, strings, template literals (with nested substitutions)
 * and regex literals well enough to find
 *
 * - `import … from "x"`, `import "x"`, `import type … from "x"`
 * - `export … from "x"`, `export * from "x"`, `export * as ns from "x"`, `export type { … } from "x"`
 * - `import("x")`, `require("x")`, `require.resolve("x")`, `import.meta.resolve("x")`
 * - `import.meta.glob("./dir/*.ts")` (vite), `new URL("./x", import.meta.url)`
 * - `vi.mock("x")`, `jest.mock("x")` and friends
 * - `/// <reference path="x" />`, `/// <reference types="x" />`
 *
 * Computed specifiers become globs when they have a static relative prefix
 * (`import(\`./locales/${lang}.json\`)`, `require("./x/" + name)`), and are reported as opaque
 * otherwise.
 *
 * Tolerance rules: `'`/`"` strings and regex literals cannot span lines, so an apostrophe in JSX
 * text or a misread `/` only affects the rest of its line; the scanner never throws.
 */

export type RefKind =
  | "import"
  | "export"
  | "dynamic"
  | "require"
  | "reference"
  | "mock"
  | "url"
  | "glob";

export interface ModuleRef {
  /** The specifier exactly as written (for `glob`: the glob pattern). */
  specifier: string;
  kind: RefKind;
  /** `import type …` / `export type … from` / `/// <reference types>`. */
  typeOnly: boolean;
  line: number;
}

export interface TemplateGlob {
  /** Static parts; a computed part sits between each pair. */
  parts: string[];
  kind: "dynamic" | "require";
  line: number;
}

export interface OpaqueLoad {
  kind: "dynamic" | "require";
  line: number;
}

export interface ModuleScan {
  refs: ModuleRef[];
  /** Computed specifiers with a static relative prefix, matched against files. */
  templates: TemplateGlob[];
  /** `import(x)` / `require(x)` with nothing static to go on. */
  opaque: OpaqueLoad[];
}

// ---------------------------------------------------------------- tokenizer

export type TokenKind = "id" | "p" | "str" | "tpl" | "num" | "re";
export type TemplatePart = "full" | "head" | "middle" | "tail";

export interface Token {
  k: TokenKind;
  /** Identifier / punctuator text, string or template chunk contents (raw). */
  v: string;
  /** Source offsets [s, e). */
  s: number;
  e: number;
  line: number;
  /** A line break precedes this token. */
  nl: boolean;
  /** Template chunk position (k === "tpl"). */
  tp?: TemplatePart;
}

const KEYWORDS_BEFORE_EXPRESSION = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
  "yield",
  "await",
]);

function regexAllowed(last: Token | null): boolean {
  if (last === null) return true;
  switch (last.k) {
    case "num":
    case "str":
    case "re":
      return false;
    case "tpl":
      return last.tp === "head" || last.tp === "middle";
    case "id":
      return KEYWORDS_BEFORE_EXPRESSION.has(last.v);
    case "p":
      return last.v !== ")" && last.v !== "]";
  }
}

function isIdStart(c: number): boolean {
  return (
    (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95 || c === 36 || (c > 127 && c !== 0xa0)
  );
}

function isIdPart(c: number): boolean {
  return isIdStart(c) || (c >= 48 && c <= 57);
}

function isSpace(c: number): boolean {
  return (
    c === 32 ||
    c === 9 ||
    c === 13 ||
    c === 11 ||
    c === 12 ||
    c === 0xa0 ||
    c === 0xfeff ||
    c === 0x2028 ||
    c === 0x2029
  );
}

const TRIPLE_SLASH = /^\s*<reference\s+(path|types)\s*=\s*["']([^"']+)["']/;

export interface TokenizeResult {
  tokens: Token[];
  /** `/// <reference …>` directives found in comments. */
  references: ModuleRef[];
}

/** Tokenize JS/TS source. Comments and whitespace are dropped; never throws. */
export function tokenize(src: string): TokenizeResult {
  const tokens: Token[] = [];
  const references: ModuleRef[] = [];
  const n = src.length;
  // 0 = `{`, 1 = `${` inside a template literal.
  const braces: number[] = [];
  let i = 0;
  let line = 1;
  let nl = true;
  let last: Token | null = null;

  const push = (k: TokenKind, v: string, s: number, e: number, tp?: TemplatePart): void => {
    const tok: Token = tp === undefined ? { k, v, s, e, line, nl } : { k, v, s, e, line, nl, tp };
    tokens.push(tok);
    last = tok;
    nl = false;
  };

  /** Advance `line` over [from, to); a comment spanning lines also counts as a line break. */
  const countLines = (from: number, to: number, breaks: boolean): void => {
    for (let j = from; j < to; j++) {
      if (src.charCodeAt(j) === 10) {
        line++;
        if (breaks) nl = true;
      }
    }
  };

  /** Scan template characters from `start` (just after "`" or "}"); emits one tpl token. */
  const templateChunk = (open: number, start: number, opening: boolean): void => {
    let j = start;
    const startLine = line;
    while (j < n) {
      const c = src.charCodeAt(j);
      if (c === 96) {
        const tok: Token = {
          k: "tpl",
          v: src.slice(start, j),
          s: open,
          e: j + 1,
          line: startLine,
          nl,
          tp: opening ? "full" : "tail",
        };
        tokens.push(tok);
        last = tok;
        nl = false;
        countLines(start, j, false);
        i = j + 1;
        return;
      }
      if (c === 92) {
        j += 2;
        continue;
      }
      if (c === 36 && src.charCodeAt(j + 1) === 123) {
        const tok: Token = {
          k: "tpl",
          v: src.slice(start, j),
          s: open,
          e: j + 2,
          line: startLine,
          nl,
          tp: opening ? "head" : "middle",
        };
        tokens.push(tok);
        last = tok;
        nl = false;
        countLines(start, j, false);
        braces.push(1);
        i = j + 2;
        return;
      }
      j++;
    }
    // Unterminated template: swallow the rest.
    const tok: Token = {
      k: "tpl",
      v: src.slice(start, n),
      s: open,
      e: n,
      line: startLine,
      nl,
      tp: opening ? "full" : "tail",
    };
    tokens.push(tok);
    last = tok;
    countLines(start, n, false);
    i = n;
  };

  if (src.startsWith("#!")) {
    const end = src.indexOf("\n");
    i = end === -1 ? n : end;
  }

  while (i < n) {
    const c = src.charCodeAt(i);
    if (c === 10) {
      line++;
      nl = true;
      i++;
      continue;
    }
    if (isSpace(c)) {
      i++;
      continue;
    }
    // Comments, regex, division.
    if (c === 47) {
      const d = src.charCodeAt(i + 1);
      if (d === 47) {
        let end = src.indexOf("\n", i);
        if (end === -1) end = n;
        if (src.charCodeAt(i + 2) === 47) {
          const m = TRIPLE_SLASH.exec(src.slice(i + 3, end));
          if (m !== null && m[2] !== undefined) {
            references.push({
              specifier: m[1] === "path" && !/^\.{0,2}\//.test(m[2]) ? `./${m[2]}` : m[2],
              kind: "reference",
              typeOnly: m[1] === "types",
              line,
            });
          }
        }
        i = end;
        continue;
      }
      if (d === 42) {
        const end = src.indexOf("*/", i + 2);
        const stop = end === -1 ? n : end + 2;
        countLines(i, stop, true);
        i = stop;
        continue;
      }
      if (regexAllowed(last)) {
        let j = i + 1;
        let inClass = false;
        let ok = false;
        while (j < n) {
          const r = src.charCodeAt(j);
          if (r === 10 || r === 13) break;
          if (r === 92) {
            const next = src.charCodeAt(j + 1);
            if (next === 10 || next === 13) break;
            j += 2;
            continue;
          }
          if (r === 91) inClass = true;
          else if (r === 93) inClass = false;
          else if (r === 47 && !inClass) {
            ok = true;
            j++;
            break;
          }
          j++;
        }
        if (ok) {
          while (j < n && isIdPart(src.charCodeAt(j))) j++;
          push("re", "", i, j);
          i = j;
          continue;
        }
        // Not a regex after all (no closing slash on this line): a lone punctuator.
      }
      push("p", "/", i, i + 1);
      i++;
      continue;
    }
    // Strings: single-line only, so a stray apostrophe (JSX text) cannot swallow code.
    if (c === 39 || c === 34) {
      let j = i + 1;
      let ok = false;
      let lines = 0;
      while (j < n) {
        const r = src.charCodeAt(j);
        if (r === c) {
          ok = true;
          break;
        }
        if (r === 92) {
          const next = src.charCodeAt(j + 1);
          if (next === 10) lines++;
          else if (next === 13 && src.charCodeAt(j + 2) === 10) {
            lines++;
            j++;
          }
          j += 2;
          continue;
        }
        if (r === 10 || r === 13) break;
        j++;
      }
      if (ok) {
        push("str", src.slice(i + 1, j), i, j + 1);
        if (lines > 0) {
          line += lines;
        }
        i = j + 1;
      } else {
        push("p", c === 39 ? "'" : '"', i, i + 1);
        i++;
      }
      continue;
    }
    if (c === 96) {
      templateChunk(i, i + 1, true);
      continue;
    }
    if (c === 123) {
      braces.push(0);
      push("p", "{", i, i + 1);
      i++;
      continue;
    }
    if (c === 125) {
      const top = braces.pop();
      if (top === 1) {
        templateChunk(i, i + 1, false);
        continue;
      }
      push("p", "}", i, i + 1);
      i++;
      continue;
    }
    if (isIdStart(c)) {
      let j = i + 1;
      while (j < n && isIdPart(src.charCodeAt(j))) j++;
      push("id", src.slice(i, j), i, j);
      i = j;
      continue;
    }
    if ((c >= 48 && c <= 57) || (c === 46 && isDigit(src.charCodeAt(i + 1)))) {
      let j = i + 1;
      while (j < n) {
        const r = src.charCodeAt(j);
        if (isIdPart(r) || r === 46) {
          j++;
          continue;
        }
        const prev = src.charCodeAt(j - 1);
        if ((r === 43 || r === 45) && (prev === 101 || prev === 69)) {
          j++;
          continue;
        }
        break;
      }
      push("num", src.slice(i, j), i, j);
      i = j;
      continue;
    }
    // Punctuators: the few multi-character ones the matchers care about.
    if (c === 61 && src.charCodeAt(i + 1) === 62) {
      push("p", "=>", i, i + 2);
      i += 2;
      continue;
    }
    if (c === 46 && src.charCodeAt(i + 1) === 46 && src.charCodeAt(i + 2) === 46) {
      push("p", "...", i, i + 3);
      i += 3;
      continue;
    }
    if (c === 63 && src.charCodeAt(i + 1) === 46 && !isDigit(src.charCodeAt(i + 2))) {
      push("p", "?.", i, i + 2);
      i += 2;
      continue;
    }
    push("p", src[i] ?? "", i, i + 1);
    i++;
  }
  return { tokens, references };
}

function isDigit(c: number): boolean {
  return c >= 48 && c <= 57;
}

// ---------------------------------------------------------------- matchers

const MOCK_FNS = new Set([
  "mock",
  "doMock",
  "unmock",
  "doUnmock",
  "importActual",
  "importMock",
  "requireActual",
  "requireMock",
  "setMock",
  "createMockFromModule",
]);

const STATEMENT_KEYWORDS = new Set([
  "import",
  "export",
  "const",
  "let",
  "var",
  "function",
  "class",
  "interface",
  "type",
  "enum",
  "declare",
]);

const isP = (t: Token | undefined, v: string): boolean =>
  t !== undefined && t.k === "p" && t.v === v;
const isId = (t: Token | undefined, v: string): boolean =>
  t !== undefined && t.k === "id" && t.v === v;
const isMemberAccess = (prev: Token | undefined): boolean => isP(prev, ".") || isP(prev, "?.");

/** Index just past the template literal starting at `t` (a head chunk), plus its static parts. */
function templateParts(tokens: readonly Token[], t: number): { parts: string[]; end: number } {
  const head = tokens[t];
  if (head === undefined || head.k !== "tpl") return { parts: [], end: t + 1 };
  if (head.tp === "full") return { parts: [head.v], end: t + 1 };
  const parts = [head.v];
  let depth = 1;
  let j = t + 1;
  for (; j < tokens.length; j++) {
    const tok = tokens[j];
    if (tok === undefined || tok.k !== "tpl") continue;
    if (tok.tp === "head") depth++;
    else if (tok.tp === "full") continue;
    else if (tok.tp === "middle") {
      if (depth === 1) parts.push(tok.v);
    } else if (tok.tp === "tail") {
      depth--;
      if (depth === 0) {
        parts.push(tok.v);
        return { parts, end: j + 1 };
      }
    }
  }
  return { parts, end: j };
}

type CallArg =
  | { type: "literal"; value: string }
  | { type: "template"; parts: string[] }
  | { type: "opaque" };

/** Classify the first argument of a call whose `(` is at index `open`. */
function firstArg(tokens: readonly Token[], open: number): CallArg {
  const a = tokens[open + 1];
  if (a === undefined) return { type: "opaque" };
  if (a.k === "str") {
    const after = tokens[open + 2];
    if (isP(after, ")") || isP(after, ",")) return { type: "literal", value: a.v };
    if (isP(after, "+")) return { type: "template", parts: [a.v, ""] };
    return { type: "opaque" };
  }
  if (a.k === "tpl") {
    if (a.tp === "full") {
      const after = tokens[open + 2];
      if (isP(after, ")") || isP(after, ",")) return { type: "literal", value: a.v };
      if (isP(after, "+")) return { type: "template", parts: [a.v, ""] };
      return { type: "opaque" };
    }
    const { parts } = templateParts(tokens, open + 1);
    return { type: "template", parts };
  }
  return { type: "opaque" };
}

/** Find `from "x"` after an import/export clause starting at `start`; returns the string token. */
function fromClause(tokens: readonly Token[], start: number): Token | null {
  const limit = Math.min(tokens.length, start + 4000);
  let depth = 0;
  for (let j = start; j < limit; j++) {
    const tok = tokens[j];
    if (tok === undefined) break;
    if (tok.k === "p") {
      if (tok.v === "{") depth++;
      else if (tok.v === "}") depth--;
      else if (depth === 0 && (tok.v === ";" || tok.v === "=" || tok.v === "(" || tok.v === ")"))
        return null;
      continue;
    }
    if (j > start && depth === 0 && tok.nl && tok.k === "id" && STATEMENT_KEYWORDS.has(tok.v)) {
      if (tok.v !== "type" || isP(tokens[j + 1], "{")) return null;
    }
    if (tok.k === "id" && tok.v === "from" && depth === 0) {
      const next = tokens[j + 1];
      if (next !== undefined && next.k === "str") return next;
    }
  }
  return null;
}

function addCall(scan: ModuleScan, kind: "dynamic" | "require", arg: CallArg, line: number): void {
  if (arg.type === "literal") {
    scan.refs.push({ specifier: arg.value, kind, typeOnly: false, line });
  } else if (arg.type === "template" && /^\.{1,2}\//.test(arg.parts[0] ?? "")) {
    scan.templates.push({ parts: arg.parts, kind, line });
  } else {
    scan.opaque.push({ kind, line });
  }
}

/** Find every module reference in `src`. */
export function scanModule(src: string): ModuleScan {
  const { tokens, references } = tokenize(src);
  return scanTokens(tokens, references);
}

export function scanTokens(tokens: readonly Token[], references: readonly ModuleRef[]): ModuleScan {
  const scan: ModuleScan = { refs: [...references], templates: [], opaque: [] };
  const n = tokens.length;
  for (let t = 0; t < n; t++) {
    const tok = tokens[t];
    if (tok === undefined || tok.k !== "id") continue;
    const prev = tokens[t - 1];
    const next = tokens[t + 1];
    switch (tok.v) {
      case "import": {
        if (isMemberAccess(prev)) break;
        if (isP(next, "(")) {
          addCall(scan, "dynamic", firstArg(tokens, t + 1), tok.line);
          break;
        }
        if (isP(next, ".")) {
          // import.meta.glob(...) / import.meta.resolve("x")
          if (!isId(tokens[t + 2], "meta") || !isP(tokens[t + 3], ".")) break;
          const fn = tokens[t + 4];
          if (!isP(tokens[t + 5], "(")) break;
          if (isId(fn, "resolve")) {
            const arg = firstArg(tokens, t + 5);
            if (arg.type === "literal")
              scan.refs.push({
                specifier: arg.value,
                kind: "dynamic",
                typeOnly: false,
                line: tok.line,
              });
          } else if (isId(fn, "glob") || isId(fn, "globEager")) {
            let j = t + 6;
            const list = isP(tokens[j], "[");
            if (list) j++;
            for (; j < n; j++) {
              const a = tokens[j];
              if (a === undefined) break;
              if (a.k === "str" || (a.k === "tpl" && a.tp === "full")) {
                scan.refs.push({ specifier: a.v, kind: "glob", typeOnly: false, line: a.line });
              } else if (!isP(a, ",")) break;
              if (!list) break;
            }
          }
          break;
        }
        if (next === undefined) break;
        if (next.k === "str") {
          scan.refs.push({ specifier: next.v, kind: "import", typeOnly: false, line: tok.line });
          break;
        }
        if (!(next.k === "id" || isP(next, "{") || isP(next, "*"))) break;
        const typeOnly =
          isId(next, "type") &&
          !isId(tokens[t + 2], "from") &&
          !isP(tokens[t + 2], ",") &&
          !isP(tokens[t + 2], "=");
        const spec = fromClause(tokens, t + 1);
        if (spec !== null)
          scan.refs.push({ specifier: spec.v, kind: "import", typeOnly, line: tok.line });
        break;
      }
      case "export": {
        if (isMemberAccess(prev) || next === undefined) break;
        let start = t + 1;
        let typeOnly = false;
        if (isId(next, "type") && (isP(tokens[t + 2], "{") || isP(tokens[t + 2], "*"))) {
          typeOnly = true;
          start = t + 2;
        }
        const head = tokens[start];
        if (!(isP(head, "{") || isP(head, "*"))) break;
        const spec = fromClause(tokens, start);
        if (spec !== null)
          scan.refs.push({ specifier: spec.v, kind: "export", typeOnly, line: tok.line });
        break;
      }
      case "require": {
        if (isMemberAccess(prev) || isId(prev, "function")) break;
        if (isP(next, "(")) {
          addCall(scan, "require", firstArg(tokens, t + 1), tok.line);
        } else if (isP(next, ".") && isId(tokens[t + 2], "resolve") && isP(tokens[t + 3], "(")) {
          const arg = firstArg(tokens, t + 3);
          if (arg.type === "literal")
            scan.refs.push({
              specifier: arg.value,
              kind: "require",
              typeOnly: false,
              line: tok.line,
            });
        }
        break;
      }
      case "vi":
      case "jest": {
        if (isMemberAccess(prev) || !isP(next, ".")) break;
        const fn = tokens[t + 2];
        if (fn === undefined || fn.k !== "id" || !MOCK_FNS.has(fn.v)) break;
        if (!isP(tokens[t + 3], "(")) break;
        const arg = firstArg(tokens, t + 3);
        if (arg.type === "literal")
          scan.refs.push({ specifier: arg.value, kind: "mock", typeOnly: false, line: tok.line });
        break;
      }
      case "URL": {
        // new URL("./x", import.meta.url)
        if (!isId(prev, "new") || !isP(next, "(")) break;
        const a = tokens[t + 2];
        if (a === undefined || !(a.k === "str" || (a.k === "tpl" && a.tp === "full"))) break;
        if (
          isP(tokens[t + 3], ",") &&
          isId(tokens[t + 4], "import") &&
          isP(tokens[t + 5], ".") &&
          isId(tokens[t + 6], "meta") &&
          isP(tokens[t + 7], ".") &&
          isId(tokens[t + 8], "url")
        ) {
          scan.refs.push({ specifier: a.v, kind: "url", typeOnly: false, line: tok.line });
        }
        break;
      }
      default:
        break;
    }
  }
  return scan;
}

/** Every string literal in `src` that looks like a relative path (`./x`, `../x`). */
export function relativeStringLiterals(src: string): string[] {
  const out: string[] = [];
  for (const tok of tokenize(src).tokens) {
    if ((tok.k === "str" || (tok.k === "tpl" && tok.tp === "full")) && /^\.{1,2}\//.test(tok.v))
      out.push(tok.v);
  }
  return out;
}

/** Keys of test-runner configs whose values are files every test loads. */
const SETUP_KEYS = new Set([
  "setupFiles",
  "globalSetup",
  "setupFilesAfterEnv",
  "globalTeardown",
  "snapshotSerializers",
  "snapshotResolver",
  "testEnvironment",
  "environment",
]);

/**
 * Relative file names a test-runner config loads for every test: string values (or arrays of
 * strings) of `setupFiles`, `globalSetup`, `setupFilesAfterEnv`, … Other strings (aliases,
 * include globs) are not "loaded by every test".
 */
export function setupFileLiterals(src: string): string[] {
  const { tokens } = tokenize(src);
  const out: string[] = [];
  const isText = (t: Token | undefined): boolean =>
    t !== undefined && (t.k === "str" || (t.k === "tpl" && t.tp === "full"));
  const relative = (t: Token | undefined): string | null =>
    t !== undefined && isText(t) && /^\.{1,2}\//.test(t.v) ? t.v : null;
  for (let i = 0; i < tokens.length; i++) {
    const key = tokens[i];
    if (key === undefined || !((key.k === "id" || key.k === "str") && SETUP_KEYS.has(key.v)))
      continue;
    if (!isP(tokens[i + 1], ":")) continue;
    const value = tokens[i + 2];
    const single = relative(value);
    if (single !== null) {
      out.push(single);
      continue;
    }
    if (!isP(value, "[")) continue;
    for (let j = i + 3; j < tokens.length; j++) {
      const t = tokens[j];
      const rel = relative(t);
      if (rel !== null) out.push(rel);
      else if (!isP(t, ",") && !isText(t)) break;
    }
  }
  return out;
}
