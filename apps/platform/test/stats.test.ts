/**
 * The live time to first green: a public, aggregate-only endpoint, and the landing page quoting
 * it (server-side, fail soft, with an ETag that changes with the numbers).
 */
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { axisPct, liveCaption } from "../src/routes/front-door.js";
import { FirstGreenStatsSchema, resetFirstGreenMemo, secondsLabel } from "../src/routes/stats.js";
import { call, makeApp } from "./http.js";

/** project_onboarding rows: `[outcome, msToGreen, msToPreview]` each. */
async function seed(rows: Array<[string | null, number | null, number | null]>): Promise<void> {
  const now = Date.now();
  let n = 0;
  for (const [outcome, green, preview] of rows) {
    n += 1;
    await env.DB.prepare(
      "INSERT INTO project_onboarding (project_id, template, source, principal_id, created_at, outcome, ms_to_green, ms_to_preview, ms_to_respond) VALUES (?, ?, 'template', 'ag_x', ?, ?, ?, ?, 9000)",
    )
      .bind(
        `proj-secret-${n}`,
        n % 2 === 0 ? "workers-api" : "static-site",
        new Date(now - n * 60_000).toISOString(),
        outcome,
        green,
        preview,
      )
      .run();
  }
}

const SIX_GREEN: Array<[string | null, number | null, number | null]> = [
  ["green", 40_000, 50_000],
  ["green", 45_000, 55_000],
  ["green", 50_000, 56_000],
  ["green", 52_000, 58_000],
  ["green", 60_000, 70_000],
  ["green", 70_000, 81_000],
  ["ci-failed", null, null],
  [null, null, null],
];

// D1 is not reset between the tests of a file: start each from an empty table.
beforeEach(async () => {
  resetFirstGreenMemo();
  await env.DB.prepare("DELETE FROM project_onboarding").run();
});

describe("GET /api/v1/stats/first-green", () => {
  it("answers without credentials, with aggregates only (no project ids)", async () => {
    await seed(SIX_GREEN);
    const { app } = makeApp();
    const res = await call(app, "GET", "/api/v1/stats/first-green");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    const text = await res.text();
    expect(text).not.toContain("proj-secret");
    expect(text).not.toContain("ag_x");
    const stats = FirstGreenStatsSchema.parse(JSON.parse(text));
    expect(stats).toMatchObject({
      projects: 8,
      finished: 7,
      green: 6,
      withinTarget: 4,
      // First green = the later of CI green and the preview serving.
      p50Ms: 56_000,
      p90Ms: 81_000,
      sinceDays: 30,
      targetMs: 60_000,
      source: "d1",
    });
    expect(stats.byTemplate.map((t) => t.template).sort()).toEqual(["static-site", "workers-api"]);
    expect(Object.keys(stats.byTemplate[0] ?? {})).not.toContain("recent");
  });

  it("is listed in the OpenAPI document and validates ?days", async () => {
    const { app } = makeApp();
    const doc = (await (await call(app, "GET", "/api/v1/openapi.json")).json()) as {
      paths: Record<string, { get?: { security?: unknown } }>;
    };
    expect(doc.paths["/api/v1/stats/first-green"]?.get).toBeDefined();
    expect((await call(app, "GET", "/api/v1/stats/first-green?days=0")).status).toBe(400);
    const empty = (await (await call(app, "GET", "/api/v1/stats/first-green?days=7")).json()) as {
      p50Ms: unknown;
      green: number;
    };
    expect(empty).toMatchObject({ p50Ms: null, green: 0 });
  });
});

describe("the landing's first-green figure", () => {
  it("keeps the static figure until there are enough green projects", async () => {
    await seed(SIX_GREEN.slice(0, 3));
    const { app } = makeApp();
    const html = await (await call(app, "GET", "/", { headers: { accept: "text/html" } })).text();
    expect(html).toMatch(/<span data-ttfg-live(="")?>Median 57\u00a0s/);
    expect(html).not.toContain("Live: median");
  });

  it("quotes the live numbers, moves the bar, and revalidates against them", async () => {
    await seed(SIX_GREEN);
    const { app } = makeApp();
    const res = await call(app, "GET", "/", { headers: { accept: "text/html" } });
    expect(res.status).toBe(200);
    const html = await res.text();
    const live = { p50Ms: 56_000, p90Ms: 81_000, green: 6, sinceDays: 30 };
    expect(html).toContain(liveCaption(live));
    expect(liveCaption(live)).toBe(
      "Live: median 56\u00a0s, 9 in 10 projects within 81\u00a0s, over the last 30 days (6 projects reached first green).",
    );
    expect(html).toContain(
      `data-ttfg-range="" style="left:${axisPct(56)};width:${axisPct(25)};"`.replace('=""', ""),
    );
    const etag = res.headers.get("etag") ?? "";
    expect(etag).toMatch(/-ttfg56\.81\.6"$/);
    const again = await call(app, "GET", "/", {
      headers: { accept: "text/html", "if-none-match": etag },
    });
    expect(again.status).toBe(304);
  });

  it("says durations the way the landing does", () => {
    const nb = (t: string) => t.replace(/ /g, "\u00a0");
    expect(secondsLabel(56_600)).toBe(nb("57 s"));
    expect(secondsLabel(89_000)).toBe(nb("89 s"));
    expect(secondsLabel(95_000)).toBe("1\u00a0min 35\u00a0s");
    expect(secondsLabel(120_000)).toBe(nb("2 min"));
    expect(axisPct(120)).toBe("100%");
  });
});
