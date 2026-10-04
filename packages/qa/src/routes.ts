/**
 * Which criteria and routes a run uses. Pure.
 */
import type { QaVerdict } from "@app/evidence";
import type { QaCriterionInput } from "./types.js";

export const SMOKE_CRITERION =
  "The affected pages load without errors (no Plan: smoke check only).";
export const MAX_ROUTES = 4;

/** The Plan's criteria, or one smoke criterion when there is no Plan. */
export function criteriaFor(plan: { acceptanceCriteria: string[] } | null): QaCriterionInput[] {
  if (plan === null || plan.acceptanceCriteria.length === 0)
    return [{ text: SMOKE_CRITERION, source: "smoke" }];
  return plan.acceptanceCriteria.map((text) => ({ text, source: "plan" as const }));
}

function cleanRoute(r: string): string | null {
  const t = r.trim();
  if (t === "" || /^[a-z]+:/i.test(t) || t.startsWith("//")) return null;
  const path = (t.startsWith("/") ? t : `/${t}`).split("#")[0] ?? "/";
  return path.length > 300 ? null : path;
}

/**
 * Routes guessed from changed paths: static pages (`public/about.html` → `/about.html`,
 * `public/index.html` → `/`) and file-based routes (`src/routes/settings.tsx` → `/settings`).
 */
export function routesFromFiles(files: readonly string[]): string[] {
  const out: string[] = [];
  for (const f of files) {
    const stat =
      /^(?:.*\/)?(?:public|static|dist|site|_site|www)\/(.+\.html?)$/.exec(f) ??
      /^([^/]+\.html?)$/.exec(f);
    if (stat?.[1]) {
      out.push(
        stat[1]
          .replace(/(^|\/)index\.html?$/, "$1")
          .replace(/^/, "/")
          .replace(/\/+$/, "/") || "/",
      );
      continue;
    }
    const route = /(?:^|\/)(?:routes|pages|app)\/(.+)\.(?:tsx|jsx|ts|js|vue|svelte|astro)$/.exec(f);
    if (route?.[1]) {
      const p = route[1].replace(/(^|\/)(index|page|route)$/, "").replace(/\[[^\]]+\]/g, "1");
      if (!p.startsWith("api/") && !p.startsWith("_")) out.push(`/${p}`);
    }
  }
  return out;
}

/** Plan routes first, then the template's, then guessed ones, then "/": unique, at most four. */
export function routesFor(input: {
  planRoutes: string[];
  templateRoutes: string[];
  changedFiles: string[];
}): string[] {
  const all = [
    ...input.planRoutes,
    ...input.templateRoutes.filter((r) => !r.startsWith("/api")),
    ...routesFromFiles(input.changedFiles),
    "/",
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of all) {
    const c = cleanRoute(r);
    if (c === null || seen.has(c)) continue;
    seen.add(c);
    out.push(c);
  }
  return out.slice(0, MAX_ROUTES);
}

const RANK: Record<QaVerdict, number> = { pass: 0, "couldnt-test": 1, fail: 2 };

/** The riskier of two verdicts: a second opinion can move a verdict down, never up to pass. */
export function worse(a: QaVerdict, b: QaVerdict): QaVerdict {
  return RANK[b] > RANK[a] ? b : a;
}
