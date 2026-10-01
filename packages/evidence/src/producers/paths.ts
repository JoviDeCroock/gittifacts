/**
 * Matching tool-reported file paths (often absolute, sometimes with backslashes)
 * to repo-relative paths from a diff.
 */

export function normalizeReportPath(p: string, root?: string): string {
  let out = p.replace(/\\/g, "/");
  if (root) {
    const r = root.replace(/\\/g, "/").replace(/\/+$/, "");
    if (r !== "" && out.startsWith(`${r}/`)) out = out.slice(r.length + 1);
  }
  while (out.startsWith("./")) out = out.slice(2);
  return out;
}

/**
 * Build a resolver from repo-relative paths to report keys. A path matches a key when,
 * after normalization, they are equal, or the key ends with "/" + path and no other key
 * does (absolute paths from CI runners). Ambiguous suffix matches resolve to nothing.
 */
export function createPathResolver(
  reportKeys: Iterable<string>,
  root?: string,
): (repoPath: string) => string | undefined {
  const exact = new Map<string, string>();
  const normalized: [string, string][] = [];
  for (const key of reportKeys) {
    const n = normalizeReportPath(key, root);
    if (!exact.has(n)) exact.set(n, key);
    normalized.push([n, key]);
  }
  return (repoPath: string) => {
    const p = normalizeReportPath(repoPath);
    const hit = exact.get(p);
    if (hit !== undefined) return hit;
    const suffix = `/${p}`;
    let found: string | undefined;
    for (const [n, key] of normalized) {
      if (n.endsWith(suffix)) {
        if (found !== undefined && found !== key) return undefined;
        found = key;
      }
    }
    return found;
  };
}
