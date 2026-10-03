/**
 * Public, aggregate-only platform numbers: `GET /api/v1/stats/first-green` is the live
 * time-to-first-green the landing page quotes (and links to), so the claim is checkable.
 *
 * Only aggregates leave here: counts and percentiles, overall and per template. Project ids and
 * per-project timings stay behind the admin dashboard (`GET /internal/ttfg`). Read from the D1
 * onboarding rows (the same rows the dashboard falls back to), memoized per isolate for five
 * minutes and cacheable for as long.
 */
import { createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import type { Services } from "../app-env.js";
import { TTFG_TARGET_MS, ttfgFromD1, ttfgReport } from "../projects/onboarding.js";
import { type ApiApp, json } from "./common.js";

export const FIRST_GREEN_STATS_PATH = "/api/v1/stats/first-green";
const TTL_MS = 5 * 60_000;

const Stats = z.object({
  projects: z.number().describe("Projects created through create_project in the window"),
  finished: z.number().describe("Projects whose first CI run and preview finished"),
  green: z.number().describe("Projects that reached first green (CI green and preview serving)"),
  withinTarget: z.number().describe("Green within the target"),
  p50Ms: z.number().nullable().describe("Median time to first green, ms (green projects only)"),
  p90Ms: z.number().nullable().describe("90th percentile, ms"),
});

export const FirstGreenStatsSchema = Stats.extend({
  sinceDays: z.number(),
  targetMs: z.number(),
  byTemplate: z.array(Stats.extend({ template: z.string() })),
  source: z.literal("d1"),
  generatedAt: z.string(),
});
export type FirstGreenStats = z.infer<typeof FirstGreenStatsSchema>;

const memo = new Map<number, { at: number; value: Promise<FirstGreenStats> }>();

/** Drops memoized results (tests). */
export function resetFirstGreenMemo(): void {
  memo.clear();
}

/** The live numbers for the last `days` days (memoized per isolate; a failure is not kept). */
export function firstGreenStats(
  svc: Pick<Services, "store" | "clock">,
  days = 30,
): Promise<FirstGreenStats> {
  const now = svc.clock.now().getTime();
  const hit = memo.get(days);
  if (hit !== undefined && now - hit.at < TTL_MS) return hit.value;
  const value = (async (): Promise<FirstGreenStats> => {
    const rows = await ttfgFromD1(svc.store, new Date(now - days * 86_400_000));
    const report = ttfgReport(rows, "d1", days, null);
    return {
      ...report.overall,
      sinceDays: days,
      targetMs: TTFG_TARGET_MS,
      byTemplate: report.byTemplate,
      source: "d1",
      generatedAt: new Date(now).toISOString(),
    };
  })();
  memo.set(days, { at: now, value });
  value.catch(() => memo.delete(days));
  return value;
}

/** "57 s" / "1 min 20 s" (no-break spaces): how the landing page says a duration. */
export function secondsLabel(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}\u00a0s`;
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return rest === 0 ? `${m}\u00a0min` : `${m}\u00a0min ${rest}\u00a0s`;
}

const route = createRoute({
  method: "get",
  path: FIRST_GREEN_STATS_PATH,
  tags: ["stats"],
  summary: "Live time-to-first-green: aggregates only (no project ids), no auth",
  description:
    "From create_project to a green first CI run and a serving preview, over the last `days` days. Percentiles count green projects only; `finished - green` failed CI or the preview. The landing page quotes these numbers.",
  request: { query: z.object({ days: z.coerce.number().int().min(1).max(90).default(30) }) },
  responses: { 200: json(FirstGreenStatsSchema, "Aggregates") },
});

export function registerStatsRoutes(app: ApiApp): void {
  app.openapi(route, async (c) => {
    const stats = await firstGreenStats(c.get("services"), c.req.valid("query").days);
    return c.json(stats, 200, {
      "cache-control": "public, max-age=300",
      "access-control-allow-origin": "*",
    });
  });
}
