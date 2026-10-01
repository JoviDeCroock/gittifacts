/**
 * Sensitive-path hits: which changed paths match which policy patterns.
 * Pass both sides of renames/deletions (see `touchedPaths`) — moving a sensitive
 * file away is as sensitive as editing it.
 */
import { truncate } from "../encoding.js";
import type { SensitivePathHits } from "../schema.js";
import { GlobError, globToRegExp, matchPathPattern } from "./glob.js";

export interface SensitivePathOptions {
  id?: string;
}

export function sensitivePathHits(
  files: readonly string[],
  patterns: readonly string[],
  opts: SensitivePathOptions = {},
): SensitivePathHits {
  const usable: string[] = [];
  const invalid: string[] = [];
  for (const pattern of patterns) {
    try {
      globToRegExp(pattern);
      usable.push(pattern);
    } catch (e) {
      if (!(e instanceof GlobError || e instanceof SyntaxError)) throw e;
      invalid.push(`${pattern}: ${e.message}`);
    }
  }
  const hits: SensitivePathHits["hits"] = [];
  for (const path of new Set(files)) {
    for (const pattern of usable) {
      if (matchPathPattern(pattern, path)) hits.push({ path, pattern });
    }
  }
  const item: SensitivePathHits = {
    id: opts.id ?? "sensitive-paths",
    kind: "sensitive-paths",
    // A pattern we could not evaluate is an unknown, not a "no hit".
    status: invalid.length > 0 ? "error" : "ok",
    patterns: [...patterns],
    hits,
  };
  if (invalid.length > 0) item.note = truncate(`invalid patterns: ${invalid.join("; ")}`, 4000);
  return item;
}
