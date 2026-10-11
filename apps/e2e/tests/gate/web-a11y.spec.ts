/**
 * Accessibility and consistency of the app's screens (WCAG 2.2 AA, packages/web/DESIGN.md), through
 * the real Worker and the built UI:
 *
 * - touch targets are at least 44px tall on a touch screen at 390 px;
 * - an in-app navigation hands focus to the new page's main (the first load doesn't);
 * - scripted scrolling respects reduced motion;
 * - the focus ring never reshapes a control;
 * - carmine, ochre and green only mean lane, verdict or state (the Band Means Lane Rule);
 * - quiet text keeps 4.5:1;
 * - a cold load tells the browser its colour scheme and paints the canvas before any stylesheet.
 *
 * States the hermetic server can't produce (a rollout in flight, a busy merge queue, GitHub
 * installations) come from the UI's demo backend (`?mock`): the same built app in a real browser.
 */
import { GITHUB_SURFACES } from "@app/domain/surfaces";
import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { expect, test } from "../../lib/fixtures.js";
import { uniqueName } from "../../lib/poll.js";
import type { Human } from "../../lib/world.js";

const TAP = 44;

type Rgba = [number, number, number, number];

interface Probes {
  /** Any CSS colour (oklch included) as sRGB bytes, through a canvas. */
  rgb(css: string): Rgba;
  /** WCAG contrast of an element's text against the first opaque background behind it. */
  contrast(el: Element): number;
  /** Which band tokens (--ok, --warn, --danger and their tints) colour an element. */
  bands(el: Element): string[];
}

interface Probed {
  __a11y: Probes;
  __scrolls: Array<{ kind: string; behavior: string | null }>;
  __rest: Map<Element, string>;
}

/** Init script: colour probes on `window.__a11y`. Self-contained (it runs in the page). */
function installProbes(): void {
  const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  const rgb = (css: string): Rgba => {
    if (!ctx) throw new Error("no 2d canvas");
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = "#000";
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return [d[0] ?? 0, d[1] ?? 0, d[2] ?? 0, d[3] ?? 0];
  };
  const token = (name: string): Rgba => {
    const probe = document.createElement("span");
    probe.style.color = `var(--${name})`;
    document.body.append(probe);
    const c = rgb(getComputedStyle(probe).color);
    probe.remove();
    return c;
  };
  const same = (a: Rgba, b: Rgba) => a.every((v, i) => Math.abs(v - (b[i] ?? 0)) <= 1);
  const luminance = ([r, g, b]: Rgba) => {
    const lin = (v: number) => {
      const s = v / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  };
  const probes: Probes = {
    rgb,
    contrast(el) {
      const fg = rgb(getComputedStyle(el).color);
      let bg: Rgba = [255, 255, 255, 255];
      for (let n: Element | null = el; n; n = n.parentElement) {
        const c = rgb(getComputedStyle(n).backgroundColor);
        if (c[3] > 0) {
          bg = c;
          break;
        }
      }
      const [a, b] = [luminance(fg), luminance(bg)].sort((x, y) => y - x) as [number, number];
      return (a + 0.05) / (b + 0.05);
    },
    bands(el) {
      const cs = getComputedStyle(el);
      const fg = rgb(cs.color);
      const bg = rgb(cs.backgroundColor);
      const out: string[] = [];
      for (const band of ["ok", "warn", "danger"]) {
        if (same(fg, token(band))) out.push(`--${band}`);
        if (bg[3] > 0 && same(bg, token(`${band}-tint`))) out.push(`--${band}-tint`);
      }
      return out;
    },
  };
  (window as unknown as Probed).__a11y = probes;
}

/** Init script: records every scripted scroll and the behavior it asked for. */
function recordScrolls(): void {
  const log: Probed["__scrolls"] = [];
  (window as unknown as Probed).__scrolls = log;
  const behavior = (arg: unknown) =>
    typeof arg === "object" && arg !== null && "behavior" in arg ? String((arg as { behavior: unknown }).behavior) : null;
  const scrollTo = window.scrollTo.bind(window) as (...args: unknown[]) => void;
  window.scrollTo = ((...args: unknown[]) => {
    log.push({ kind: "scrollTo", behavior: behavior(args[0]) });
    scrollTo(...args);
  }) as typeof window.scrollTo;
  const intoView = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function (this: Element, arg?: boolean | ScrollIntoViewOptions) {
    log.push({ kind: "scrollIntoView", behavior: behavior(arg) });
    intoView.call(this, arg);
  };
}

async function approvePlan(request: APIRequestContext, baseURL: string, human: Human, planId: string): Promise<void> {
  const res = await request.post(`${baseURL}/api/v1/plans/${planId}/approve`, {
    headers: { cookie: human.cookie, origin: baseURL },
    data: {},
  });
  expect(res.status(), `approve the plan: ${await res.text()}`).toBe(200);
}

async function createAgent(request: APIRequestContext, baseURL: string, human: Human): Promise<void> {
  const res = await request.post(`${baseURL}/api/v1/principals/agents`, {
    headers: { cookie: human.cookie, origin: baseURL },
    data: { name: uniqueName("a11y").toLowerCase(), scopes: ["repo:read"] },
  });
  expect(res.status(), `create an agent: ${await res.text()}`).toBe(201);
}

/** The phone project is a touch screen: the coarse-pointer rules are the ones under test. */
async function expectCoarse(page: Page): Promise<void> {
  const coarse = await page.evaluate(() => window.matchMedia("(pointer: coarse)").matches);
  expect(coarse, "the phone project emulates a coarse pointer").toBe(true);
}

/** Every rendered match is at least 44px tall (half a pixel for subpixel layout). */
async function expectTargets(targets: Locator, what: string): Promise<void> {
  const heights = await targets.evaluateAll((els) =>
    els.filter((e) => e.getClientRects().length > 0).map((e) => e.getBoundingClientRect().height),
  );
  expect(heights.length, `${what}: none rendered`).toBeGreaterThan(0);
  for (const h of heights) expect(h, `${what}: target height in px`).toBeGreaterThanOrEqual(TAP - 0.5);
}

const focusedId = (page: Page) => page.evaluate(() => document.activeElement?.id ?? "");

function expectSameColour(actual: number[] | undefined, expected: number[], what: string): void {
  expect(actual, what).toBeDefined();
  for (const [i, v] of expected.slice(0, 3).entries()) {
    expect(Math.abs((actual?.[i] ?? -99) - v), `${what}: channel ${i} of ${actual} vs ${expected}`).toBeLessThanOrEqual(2);
  }
}

test.describe("touch targets at 390 px", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "phone", "a coarse-pointer rule: the desktop layout stays as it is");
  });

  test("a repo's plan links and the audit log's hash toggles", async ({ authed: page, world, request, baseURL, human }) => {
    // An approved Plan is listed in the repo's side column.
    await approvePlan(request, baseURL as string, human, world.planId);
    await page.goto(`/repos/${world.repoId}`);
    await expectCoarse(page);
    const plan = page.locator(`a[href="/plans/${world.planId}"]`);
    await expect(plan).toBeVisible();
    await expectTargets(plan, "a repo's plan link");

    await page.goto("/audit");
    const toggles = page.locator(".audit__hash > summary");
    await expect(toggles.first()).toBeVisible();
    await expectTargets(toggles, "an audit event's hash toggle");
  });

  test("the merge queue's links and GitHub repo names (demo data)", async ({ authed: page }) => {
    await page.goto("/repos/repo_billing/queue?mock");
    await expectCoarse(page);
    await expect(page.locator(".q-entry__title").first()).toBeVisible();
    await expectTargets(page.locator(".q-entry__title"), "a queue entry's title");
    // Phones fold the tracks under the per-change list; the summary is itself a target.
    const tracks = page.locator(".q-fold > summary");
    await expectTargets(tracks, "the tracks disclosure");
    await tracks.click();
    await expectTargets(page.locator(".q-batch__members a"), "a batch member");
    await expectTargets(page.locator(".q-fig dt a"), "the flake-rate link");

    // GitHub surfaces are switched off for now (@app/domain/surfaces): no page to check.
    if (!GITHUB_SURFACES) return;
    await page.goto("/settings/github?mock");
    await expect(page.locator(".gh-repo__name a").first()).toBeVisible();
    await expectTargets(page.locator(".gh-repo__name a"), "a GitHub repo name");
  });
});

test("an in-app navigation hands focus to the new page; the first load doesn't", async ({ authed: page, world }) => {
  // Signed in, /signin?next= only redirects: still the first load.
  await page.goto(`/signin?next=${encodeURIComponent(`/repos/${world.repoId}`)}`);
  await expect(page).toHaveURL(new RegExp(`/repos/${world.repoId}$`));
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  expect(await focusedId(page)).not.toBe("main");

  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  expect(await focusedId(page)).not.toBe("main");
  // Following a link: the new page's main takes focus, the page starts at the top, and the next
  // Tab lands inside the page (not back at the top of the document).
  await page.getByRole("main").getByRole("link", { name: new RegExp(world.repoName) }).first().click();
  await expect(page).toHaveURL(new RegExp(`/repos/${world.repoId}$`));
  await expect.poll(() => focusedId(page)).toBe("main");
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  // Once the page has loaded (while it loads, a phone's main holds nothing to Tab to).
  await expect(page.getByRole("link", { name: /Rate limit logins/ }).first()).toBeVisible();
  expect(await focusedId(page), "loading the page's data keeps focus on main").toBe("main");
  await page.keyboard.press("Tab");
  const next = await page.evaluate(() => ({
    inside: document.getElementById("main")?.contains(document.activeElement) ?? false,
    what: document.activeElement?.outerHTML.slice(0, 120) ?? "nothing",
  }));
  expect(next.inside, `the next Tab lands inside the page, not on ${next.what}`).toBe(true);

  // History navigation does the same.
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.goBack();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect.poll(() => focusedId(page)).toBe("main");
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
});

test("scripted scrolling respects reduced motion", async ({ authed: page, world }, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(recordScrolls);
  const scrolls = () => page.evaluate(() => (window as unknown as Probed).__scrolls);

  // Creating an agent scrolls back up to its one-time token.
  await page.goto("/agents");
  await page.getByTestId("create-agent-open").click();
  const form = page.getByTestId("create-agent");
  await form.getByRole("textbox").fill(uniqueName("a11y").toLowerCase());
  await form.locator('button[type="submit"]').click();
  await expect(page.getByTestId("agent-token")).toBeVisible();
  const afterCreate = await scrolls();
  expect(afterCreate.filter((s) => s.kind === "scrollTo" && s.behavior !== null), "the scroll to the token").not.toHaveLength(0);
  expect(afterCreate.filter((s) => s.behavior === "smooth")).toEqual([]);

  // On phones, the plan's bottom bar jumps to the signature panel.
  if (testInfo.project.name === "phone") {
    await page.goto(`/plans/${world.planId}`);
    await page.getByTestId("plan-jump-to-sign").click();
    await expect(page.locator("#sign")).toBeInViewport();
    const afterJump = await scrolls();
    expect(afterJump.filter((s) => s.kind === "scrollIntoView"), "the jump to the signature").not.toHaveLength(0);
    expect(afterJump.filter((s) => s.behavior === "smooth")).toEqual([]);
  }
});

test("the focus ring keeps each control's own shape", async ({ authed: page, world }) => {
  await page.goto(`/repos/${world.repoId}`);
  await expect(page.getByRole("link", { name: /Rate limit logins/ }).first()).toBeVisible();
  // Every control's corner radius at rest, before anything has focus (and after the page loaded).
  await page.evaluate(() => {
    const rest = new Map<Element, string>();
    for (const el of document.querySelectorAll("a[href], button, summary, input, select, textarea, [tabindex]")) {
      rest.set(el, getComputedStyle(el).borderRadius);
    }
    (window as unknown as Probed).__rest = rest;
  });
  const checked: Array<{ what: string; rest: string; focused: string }> = [];
  for (let i = 0; i < 24; i++) {
    await page.keyboard.press("Tab");
    const seen = await page.evaluate(() => {
      const el = document.activeElement;
      const rest = el ? (window as unknown as Probed).__rest.get(el) : undefined;
      // Bare inline links (no class) may round their ring: they have no shape of their own.
      if (!el || rest === undefined || !el.matches(":focus-visible") || (el.tagName === "A" && !el.hasAttribute("class"))) return null;
      return { what: el.outerHTML.slice(0, 90), rest, focused: getComputedStyle(el).borderRadius };
    });
    if (seen) checked.push(seen);
  }
  expect(checked.length, "controls reached by Tab").toBeGreaterThan(3);
  expect(checked.some((c) => c.rest === "0px"), `a control without a radius of its own among ${JSON.stringify(checked)}`).toBe(true);
  for (const c of checked) expect(c.focused, `radius while focused: ${c.what}`).toBe(c.rest);
});

test("bands mean lane, verdict or state: an active agent and a rollout in flight are ink", async ({ authed: page, request, baseURL, human }) => {
  await page.addInitScript(installProbes);
  const bands = (target: Locator) => target.evaluate((el) => (window as unknown as Probed).__a11y.bands(el));

  await createAgent(request, baseURL as string, human);
  await page.goto("/agents");
  const active = page.getByTestId("agent-status").and(page.locator('[data-status="active"]')).first();
  await expect(active).toBeVisible();
  expect(await bands(active), "the Active chip").toEqual([]);

  // A rollout in flight (demo data): the dashboard's count and the rollout page's state line.
  await page.goto("/dashboard?mock");
  const flight = page.locator(".flight:not(.flight--danger)").first();
  await expect(flight).toBeVisible();
  expect(await bands(flight), "rollouts in flight").toEqual([]);
  await page.goto("/changes/chg_fx2r7/rollout?mock");
  const state = page.locator(".rollout-state");
  await expect(state).toBeVisible();
  await expect(state).not.toHaveClass(/rollout-state--(ok|warn|danger)\b/);
  expect(await bands(state.locator(".icon").first()), "the rollout state's icon").toEqual([]);
});

test("quiet text keeps 4.5:1: a repo's zero lane counts, light and dark", async ({ authed: page, world }) => {
  await page.addInitScript(installProbes);
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await page.goto("/dashboard");
    await expect(page.getByRole("main").getByRole("link", { name: new RegExp(world.repoName) }).first()).toBeVisible();
    const zeros = page.locator(".lane-count.is-zero b");
    await expect(zeros.first()).toBeVisible();
    const ratios = await zeros.evaluateAll((els) => els.map((e) => (window as unknown as Probed).__a11y.contrast(e)));
    for (const r of ratios) expect(r, `${colorScheme}: a zero count's contrast`).toBeGreaterThanOrEqual(4.5);
  }
});

for (const colorScheme of ["light", "dark"] as const) {
  test(`a cold load in ${colorScheme} mode: the scheme is declared and the canvas paints before any stylesheet`, async ({ authed: page }) => {
    await page.addInitScript(installProbes);
    await page.emulateMedia({ colorScheme });
    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const styled = await page.evaluate(() => {
      const { rgb } = (window as unknown as Probed).__a11y;
      const themes = [...document.querySelectorAll('meta[name="theme-color"]')]
        .filter((m) => window.matchMedia(m.getAttribute("media") ?? "all").matches)
        .map((m) => rgb(m.getAttribute("content") ?? "transparent"));
      return {
        scheme: document.querySelector('meta[name="color-scheme"]')?.getAttribute("content") ?? null,
        themes,
        canvas: rgb(getComputedStyle(document.documentElement).backgroundColor),
      };
    });
    expect(styled.scheme).toBe("light dark");
    expect(styled.themes, "one theme-color for this scheme").toHaveLength(1);
    expectSameColour(styled.themes[0], styled.canvas, "theme-color vs the canvas token");

    // Every stylesheet empty: only index.html's inline style paints the ground.
    await page.route((url) => url.pathname.endsWith(".css"), (route) => route.fulfill({ status: 200, contentType: "text/css", body: "" }));
    await page.goto("/dashboard");
    const bare = await page.evaluate(() => (window as unknown as Probed).__a11y.rgb(getComputedStyle(document.documentElement).backgroundColor));
    expectSameColour(bare, styled.canvas, "the ground before CSS vs the canvas token");
  });
}
