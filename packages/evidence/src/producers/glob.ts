/**
 * A small, dependency-free glob matcher for repo paths ("/"-separated, no leading "/").
 *
 * Syntax: `*` (any run within a segment), `?` (one char within a segment), `**` as a
 * whole segment (zero or more segments), `{a,b}` alternation (nestable; a group without
 * a top-level comma is literal), `[abc]` / `[a-z]` / `[!a]` classes, `\` escapes.
 * Dotfiles are NOT special: `*` matches `.env` and `**` descends into `.github`.
 *
 * Two entry points:
 * - {@link matchGlob}: the pattern must match the WHOLE path.
 * - {@link matchPathPattern}: gitignore/CODEOWNERS-style, used for policy patterns:
 *   a pattern without "/" matches at any depth (`*.pem` ≡ `**​/*.pem`); a leading "/"
 *   anchors to the repo root; a trailing "/" matches only directories; and a pattern
 *   that matches a parent directory matches everything under it (`infra` matches
 *   `infra/main.tf`). Broader on purpose: for sensitive paths a false hit is cheap.
 */

export class GlobError extends Error {
  override readonly name = "GlobError";
}

const MAX_EXPANSIONS = 1024;

function findGroup(p: string, start: number): { end: number; commas: number[] } | null {
  let depth = 0;
  const commas: number[] = [];
  for (let j = start; j < p.length; j++) {
    const c = p[j];
    if (c === "\\") {
      j++;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return { end: j, commas };
    } else if (c === "," && depth === 1) commas.push(j);
  }
  return null;
}

function classEnd(s: string, start: number): number {
  let j = start + 1;
  if (s[j] === "!" || s[j] === "^") j++;
  if (s[j] === "]") j++;
  while (j < s.length && s[j] !== "]") j += s[j] === "\\" ? 2 : 1;
  return j < s.length ? j : -1;
}

function expandInto(p: string, out: string[]): void {
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "[") {
      const end = classEnd(p, i);
      if (end > 0) i = end;
      continue;
    }
    if (c !== "{") continue;
    const g = findGroup(p, i);
    if (!g || g.commas.length === 0) continue; // literal brace
    const bounds = [i, ...g.commas, g.end];
    for (let k = 0; k < bounds.length - 1; k++) {
      const alt = p.slice(bounds[k]! + 1, bounds[k + 1]);
      expandInto(p.slice(0, i) + alt + p.slice(g.end + 1), out);
      if (out.length > MAX_EXPANSIONS)
        throw new GlobError(`pattern expands to more than ${MAX_EXPANSIONS} alternatives`);
    }
    return;
  }
  out.push(p);
}

/** Brace expansion, e.g. `src/{a,b}.{ts,js}` → 4 patterns. */
export function expandBraces(pattern: string): string[] {
  const out: string[] = [];
  expandInto(pattern, out);
  return out;
}

// Only SyntaxCharacters and "/" may be escaped under the `u` flag.
const escapeRe = (c: string): string => c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

function segmentToRe(seg: string): string {
  let re = "";
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i]!;
    if (c === "\\" && i + 1 < seg.length) {
      re += escapeRe(seg[++i]!);
    } else if (c === "*") {
      while (seg[i + 1] === "*") i++;
      re += "[^/]*";
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "[") {
      const end = classEnd(seg, i);
      if (end < 0) {
        re += "\\[";
        continue;
      }
      let body = seg.slice(i + 1, end);
      const negate = body.startsWith("!") || body.startsWith("^");
      if (negate) body = body.slice(1);
      let cls = "";
      for (let k = 0; k < body.length; k++) {
        let ch = body[k]!;
        if (ch === "\\" && k + 1 < body.length) ch = body[++k]!;
        else if (ch === "-" && k > 0 && k < body.length - 1) {
          cls += "-";
          continue;
        }
        cls += /[\\\]^[-]/.test(ch) ? `\\${ch}` : ch;
      }
      re += negate ? `[^/${cls}]` : `[${cls}]`;
      i = end;
    } else {
      re += escapeRe(c);
    }
  }
  return re;
}

function compileBraceFree(p: string): string {
  const segs = p.split("/");
  let re = "";
  let needSep = false;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]!;
    if (seg === "**") {
      if (i === segs.length - 1) re += needSep ? "(?:/[\\s\\S]*)?" : "[\\s\\S]*";
      else {
        re += needSep ? "/(?:[\\s\\S]*/)?" : "(?:[\\s\\S]*/)?";
        needSep = false;
      }
    } else {
      if (needSep) re += "/";
      re += segmentToRe(seg);
      needSep = true;
    }
  }
  return re;
}

const cache = new Map<string, RegExp>();

/** Compile a glob to an anchored RegExp matching whole paths. Cached. */
export function globToRegExp(pattern: string): RegExp {
  let re = cache.get(pattern);
  if (!re) {
    const alts = expandBraces(pattern).map(compileBraceFree);
    re = new RegExp(`^(?:${alts.join("|")})$`, "u");
    if (cache.size > 2000) cache.clear();
    cache.set(pattern, re);
  }
  return re;
}

function normalizePath(path: string): string {
  let p = path;
  while (p.startsWith("./")) p = p.slice(2);
  return p;
}

/** Whole-path glob match. */
export function matchGlob(pattern: string, path: string): boolean {
  return globToRegExp(pattern).test(normalizePath(path));
}

/** gitignore-style match (see module docs). */
export function matchPathPattern(pattern: string, path: string): boolean {
  let p = pattern;
  let anchored = false;
  if (p.startsWith("/")) {
    anchored = true;
    p = p.replace(/^\/+/, "");
  } else if (p.startsWith("./")) {
    anchored = true;
    p = normalizePath(p);
  }
  const dirOnly = p.endsWith("/");
  if (dirOnly) p = p.replace(/\/+$/, "");
  if (p === "") return dirOnly || anchored;
  if (!anchored && !p.includes("/")) p = `**/${p}`;
  const re = globToRegExp(p);
  const target = normalizePath(path);
  if (!dirOnly && re.test(target)) return true;
  for (let i = target.indexOf("/"); i >= 0; i = target.indexOf("/", i + 1)) {
    if (re.test(target.slice(0, i))) return true;
  }
  return false;
}

/** First pattern (in order) that matches, gitignore-style. */
export function firstMatchingPattern(
  patterns: readonly string[],
  path: string,
): string | undefined {
  return patterns.find((pat) => matchPathPattern(pat, path));
}
