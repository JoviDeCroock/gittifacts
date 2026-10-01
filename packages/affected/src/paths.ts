/** Repo-relative POSIX path helpers (pure; no node:path so the package also runs in Workers). */

/** Directory of a repo path ("" for top-level files). */
export function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

/** Last path segment. */
export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * Join and normalize repo-relative segments. Returns null when the result would leave the
 * repository (more `..` than directories).
 */
export function joinPath(...parts: string[]): string | null {
  const out: string[] = [];
  for (const part of parts) {
    for (const seg of part.split("/")) {
      if (seg === "" || seg === ".") continue;
      if (seg === "..") {
        if (out.length === 0) return null;
        out.pop();
      } else out.push(seg);
    }
  }
  return out.join("/");
}

/** `path` is `dir` itself or inside it ("" contains everything). */
export function isUnder(path: string, dir: string): boolean {
  return dir === "" || path === dir || path.startsWith(`${dir}/`);
}

/** Every ancestor directory of `path`'s directory, nearest first, ending with "". */
export function ancestors(path: string): string[] {
  const out: string[] = [];
  let dir = dirOf(path);
  for (;;) {
    out.push(dir);
    if (dir === "") return out;
    dir = dirOf(dir);
  }
}

/** Sorted, de-duplicated copy. */
export function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Normalize a tool-reported path: backslashes, a root prefix, leading `./`. */
export function normalizeReported(p: string, root?: string): string {
  let out = p.replace(/\\/g, "/");
  if (root !== undefined && root !== "") {
    const r = root.replace(/\\/g, "/").replace(/\/+$/, "");
    if (out.startsWith(`${r}/`)) out = out.slice(r.length + 1);
  }
  while (out.startsWith("./")) out = out.slice(2);
  return out;
}

/**
 * Map tool-reported paths (often absolute) to repo files: exact match after normalization,
 * else the unique repo file that the reported path ends with. Ambiguous → undefined.
 */
export function createFileMatcher(
  files: Iterable<string>,
  root?: string,
): (reported: string) => string | undefined {
  const set = new Set(files);
  // Index repo files by their last segment for suffix matching.
  const byBase = new Map<string, string[]>();
  for (const f of set) {
    const b = baseName(f);
    const list = byBase.get(b);
    if (list === undefined) byBase.set(b, [f]);
    else list.push(f);
  }
  return (reported) => {
    const p = normalizeReported(reported, root);
    if (set.has(p)) return p;
    const candidates = byBase.get(baseName(p)) ?? [];
    let found: string | undefined;
    for (const f of candidates) {
      if (p.endsWith(`/${f}`)) {
        // Prefer the longest repo path that matches (most specific).
        if (found === undefined || f.length > found.length) found = f;
        else if (f.length === found.length) return undefined;
      }
    }
    return found;
  };
}

/**
 * Glob → RegExp for repo-relative paths: `**` spans directories, `*` and `?` stay within a
 * segment, `{a,b}` alternation. Dotfiles match.
 */
export function globToRegExp(glob: string): RegExp {
  let src = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob.charAt(i);
    if (c === "*") {
      const double = glob.charAt(i + 1) === "*";
      const segStart = i === 0 || glob.charAt(i - 1) === "/";
      if (double && segStart && glob.charAt(i + 2) === "/") {
        src += "(?:.*/)?";
        i += 2;
      } else if (double && segStart && i + 2 === glob.length) {
        src += ".*";
        i += 1;
      } else {
        src += "[^/]*";
        if (double) i += 1;
      }
    } else if (c === "?") {
      src += "[^/]";
    } else if (c === "{") {
      const end = glob.indexOf("}", i);
      if (end === -1) {
        src += "\\{";
        continue;
      }
      const alts = glob
        .slice(i + 1, end)
        .split(",")
        .map((a) => a.replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"));
      src += `(?:${alts.join("|")})`;
      i = end;
    } else {
      src += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`${src}$`);
}

/** Escape a literal for use inside a RegExp. */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
