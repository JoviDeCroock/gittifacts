/**
 * The landing's live time-to-first-green figure stays inside the page whatever the numbers: with a
 * p90 far past the 90 s axis (staging had 446 s), the bar ends at the axis, marked "past", and
 * nothing scrolls sideways at 390 or 1280 px. Seeded rows feed the real Worker's live rewrite.
 */
import { expect, expectNoHorizontalScroll, test } from "../../lib/fixtures.js";
import { seedCall } from "../../lib/world.js";

test("landing: a long first-green tail never widens the page", async ({
  page,
  request,
  baseURL,
}) => {
  await seedCall(request, baseURL as string, "/__e2e/ttfg", {});
  const range = page.locator("[data-ttfg-range]");
  // The Worker waits at most 250 ms for the live numbers and memoizes them: reload until they're in.
  await expect
    .poll(
      async () => {
        await page.goto("/");
        return range.getAttribute("data-past");
      },
      { timeout: 15_000 },
    )
    .toBe("");
  await range.scrollIntoViewIfNeeded();
  const [bar, axis] = await Promise.all([
    range.boundingBox(),
    page.locator(".ttfg__axis").boundingBox(),
  ]);
  expect(bar && axis ? bar.x + bar.width : Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
    (axis?.x ?? 0) + (axis?.width ?? 0) + 1,
  );
  await expectNoHorizontalScroll(page);
});
