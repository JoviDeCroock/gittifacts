/**
 * Public API diff over pre-extracted export surfaces.
 *
 * An `ExportSurface` maps exported symbol name → normalized signature text (extracted
 * from `.d.ts` with the TS compiler elsewhere). Any removed symbol or changed signature
 * is "breaking"; only additions is "additive"; otherwise "none". Signature-level
 * compatibility (e.g. an added optional parameter) is deliberately NOT inferred here —
 * a changed signature string is breaking until a human or a stricter tool says otherwise.
 */
import { truncate } from "../encoding.js";
import type { ApiChange, ApiClassification, PublicApiDiff } from "../schema.js";

export type ExportSurface = Readonly<Record<string, string>>;

export interface ApiSurfaceDiff {
  classification: ApiClassification;
  added: ApiChange[];
  removed: ApiChange[];
  changed: ApiChange[];
}

const SIG_MAX = 4000;
const sig = (s: string): string => truncate(s, SIG_MAX);

export function diffApiSurface(base: ExportSurface, head: ExportSurface): ApiSurfaceDiff {
  const added: ApiChange[] = [];
  const removed: ApiChange[] = [];
  const changed: ApiChange[] = [];
  // Object.keys/hasOwn: symbols like "constructor" or "__proto__" must not hit the prototype.
  for (const symbol of Object.keys(head).sort()) {
    const after = head[symbol]!;
    if (!Object.hasOwn(base, symbol)) added.push({ symbol, after: sig(after) });
    else if (base[symbol] !== after)
      changed.push({ symbol, before: sig(base[symbol]!), after: sig(after) });
  }
  for (const symbol of Object.keys(base).sort()) {
    if (!Object.hasOwn(head, symbol)) removed.push({ symbol, before: sig(base[symbol]!) });
  }
  const classification: ApiClassification =
    removed.length > 0 || changed.length > 0 ? "breaking" : added.length > 0 ? "additive" : "none";
  return { classification, added, removed, changed };
}

const RANK: Record<ApiClassification, number> = { none: 0, additive: 1, breaking: 2 };

export function maxClassification(...cs: ApiClassification[]): ApiClassification {
  return cs.reduce<ApiClassification>((a, b) => (RANK[b] > RANK[a] ? b : a), "none");
}

export interface PackageSurfaces {
  name: string;
  /** Entry point the surface was extracted from, e.g. "." or "./node". */
  entry: string;
  /** null = the entry did not exist on that side. */
  base: ExportSurface | null;
  head: ExportSurface | null;
}

/** Build a `public-api` item; overall classification is the worst across packages. */
export function publicApiDiff(
  packages: readonly PackageSurfaces[],
  opts: { id?: string } = {},
): PublicApiDiff {
  const out: PublicApiDiff["packages"] = [];
  let overall: ApiClassification = "none";
  for (const p of packages) {
    const d = diffApiSurface(p.base ?? {}, p.head ?? {});
    // A removed entry point is breaking even if it exported nothing.
    const c = p.base !== null && p.head === null ? "breaking" : d.classification;
    overall = maxClassification(overall, c);
    out.push({
      name: p.name,
      entry: p.entry,
      added: d.added,
      removed: d.removed,
      changed: d.changed,
    });
  }
  return {
    id: opts.id ?? "public-api",
    kind: "public-api",
    status: "ok",
    classification: overall,
    packages: out,
  };
}
