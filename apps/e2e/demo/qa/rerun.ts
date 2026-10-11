/** Live demo: Run QA again on the native demo Change from its page, then screenshot the result. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const BASE = "https://gittifacts.decroockjovi.workers.dev";
const OUT = process.env.OUT as string;
const st = JSON.parse(readFileSync(join(OUT, "..", "qa-native-state.json"), "utf8")) as {
  cookie: string;
  changeId: string;
};
const browser = await chromium.launch();
const t0 = Date.now();
for (const [name, viewport] of [
  ["desktop", { width: 1280, height: 900 }],
  ["phone", { width: 390, height: 844 }],
] as const) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2 });
  const [k, v] = st.cookie.split("=");
  await ctx.addCookies([
    {
      name: k as string,
      value: v as string,
      url: BASE,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    },
  ]);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/changes/${st.changeId}#qa`);
  const qa = page.getByTestId("qa");
  await qa.scrollIntoViewIfNeeded();
  if (name === "desktop") {
    const before = await qa.getAttribute("data-status");
    await qa.getByTestId("qa-run").click();
    await page
      .locator(
        '[data-testid="qa"][data-status="running"], [data-testid="qa"][data-status="queued"]',
      )
      .waitFor({ timeout: 30_000 });
    console.log("was", before);
    await page
      .locator('[data-testid="qa"][data-status="done"], [data-testid="qa"][data-status="failed"]')
      .waitFor({ timeout: 300_000 });
    console.log(`QA again: ${(Date.now() - t0) / 1000}s`);
  }
  await page.waitForTimeout(3000);
  await qa.screenshot({
    path: join(OUT, `16-qa-native-${process.env.TAG ?? "final"}-${name}.png`),
  });
  if (name === "desktop") {
    await page.locator(".qa-replay summary").click();
    await page.waitForTimeout(3000);
    await page
      .locator(".qa-replay")
      .screenshot({ path: join(OUT, `16-qa-native-${process.env.TAG ?? "final"}-replay.png`) });
    const fail = page.locator('[data-verdict="fail"]').first();
    await fail.screenshot({
      path: join(OUT, `16-qa-native-${process.env.TAG ?? "final"}-fail-criterion.png`),
    });
  }
  await ctx.close();
}
await browser.close();
const res = await fetch(`${BASE}/api/v1/changes/${st.changeId}/qa`, {
  headers: { cookie: st.cookie },
});
const runs = ((await res.json()) as { runs: Array<Record<string, unknown>> }).runs;
console.log(
  JSON.stringify(
    runs.map((r) => ({
      id: r.id,
      status: r.status,
      summary: r.summary,
      costUsd: r.costUsd,
      wallMs: r.wallMs,
      createdAt: r.createdAt,
      finishedAt: r.finishedAt,
    })),
  ),
);
