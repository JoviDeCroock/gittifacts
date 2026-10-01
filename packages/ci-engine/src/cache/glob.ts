/**
 * Minimal glob matcher for cache inputs, anchored at the repository root.
 *
 * `*` and `?` stay inside a path segment, `**` crosses segments (`**​/x` also matches `x` at the
 * root), `{a,b}` alternates (not nested), `[...]`/`[!...]` are character classes, and a trailing
 * `/` means "everything below". No negation: cache inputs only add files.
 */
const SPECIAL = /[\\^$.*+?()[\]{}|]/g;

export function globToRegExp(glob: string): RegExp {
  let g = glob.trim();
  while (g.startsWith("./")) g = g.slice(2);
  if (g.endsWith("/")) g += "**";
  let out = "^";
  let inBraces = false;
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === "*") {
      if (g[i + 1] === "*") {
        const atSegmentStart = i === 0 || g[i - 1] === "/";
        if (g[i + 2] === "/" && atSegmentStart) {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else if (c === "[") {
      const close = g.indexOf("]", i + 2);
      if (close === -1) {
        out += "\\[";
      } else {
        let body = g.slice(i + 1, close);
        if (body.startsWith("!")) body = `^${body.slice(1)}`;
        out += `[${body.replaceAll("\\", "\\\\").replaceAll("/", "")}]`;
        i = close;
      }
    } else if (c === "{" && !inBraces && g.indexOf("}", i) !== -1) {
      inBraces = true;
      out += "(?:";
    } else if (c === "}" && inBraces) {
      inBraces = false;
      out += ")";
    } else if (c === "," && inBraces) {
      out += "|";
    } else {
      out += c.replace(SPECIAL, "\\$&");
    }
  }
  return new RegExp(`${out}$`);
}

export type PathMatcher = (path: string) => boolean;

export function compileGlobs(globs: readonly string[]): PathMatcher {
  const res = globs.map(globToRegExp);
  return (path) => res.some((re) => re.test(path));
}
