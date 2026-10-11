/**
 * The Agents page as each agent's home, and the trail it links to: a row's Trail opens the audit
 * log filtered to that agent (`/audit?actor=`), and the filter shows only its events. Also the
 * dashboard's band: a keyboard focus ring that isn't clipped by the row, and a dashboard that
 * arrives in place (no layout shift inside the main column while its three parts load).
 * Roles, test ids and seeded data only (docs/testing.md); demo data where the gate has no history.
 */
import type { APIRequestContext } from "@playwright/test";
import { expect, expectNoHorizontalScroll, test } from "../../lib/fixtures.js";
import { uniqueName } from "../../lib/poll.js";
import type { Human } from "../../lib/world.js";

async function createAgent(
  request: APIRequestContext,
  baseURL: string,
  human: Human,
): Promise<{ id: string; name: string }> {
  const name = uniqueName("home").toLowerCase();
  const res = await request.post(`${baseURL}/api/v1/principals/agents`, {
    headers: { cookie: human.cookie, origin: baseURL },
    data: { name, scopes: ["repo:read"], expiresInDays: 30 },
  });
  expect(res.status(), `create an agent: ${await res.text()}`).toBe(201);
  const { principal } = (await res.json()) as { principal: { id: string } };
  return { id: principal.id, name };
}

test("agents: each row links its trail, and the trail shows only that actor's events", async ({
  authed: page,
  request,
  baseURL,
  human,
}) => {
  const agent = await createAgent(request, baseURL as string, human);
  await page.goto("/agents");
  const row = page.getByTestId("agent-row").and(page.locator(`[data-agent="${agent.id}"]`));
  await expect(row).toBeVisible();
  const trail = row.getByTestId("agent-trail");
  await expect(trail).toHaveAttribute("href", `/audit?actor=${encodeURIComponent(agent.id)}`);
  // Revoke is quiet until the confirmation names it.
  await expect(row.getByTestId("agent-revoke")).not.toHaveClass(/btn--danger/);
  await expectNoHorizontalScroll(page);

  // The person who created it has a trail too: creating the agent is theirs.
  await page.goto(`/audit?actor=${encodeURIComponent(human.principalId)}`);
  const events = page.getByTestId("audit-event");
  await expect(events.first()).toBeVisible();
  const actors = await events.evaluateAll((els) => [
    ...new Set(els.map((e) => e.getAttribute("data-actor"))),
  ]);
  expect(actors).toEqual([human.principalId]);
  await expect(page.getByTestId("audit-filter-actor")).toHaveValue(human.principalId);
});

test("audit: picking who filters the log and keeps it in the URL (demo data)", async ({
  authed: page,
}) => {
  await page.goto("/agents?mock");
  const row = page.getByTestId("agent-row").and(page.locator('[data-agent="prn_coder07"]'));
  await row.getByTestId("agent-trail").click();
  await expect(page).toHaveURL(/\/audit\?actor=prn_coder07$/);
  const events = page.getByTestId("audit-event");
  await expect(events.first()).toBeVisible();
  const actors = await events.evaluateAll((els) => [
    ...new Set(els.map((e) => e.getAttribute("data-actor"))),
  ]);
  expect(actors).toEqual(["prn_coder07"]);
  // Subjects read by title, not by raw id.
  await expect(events.first().locator(".audit__title")).not.toBeEmpty();

  // Clearing the filter brings everyone back (with a filter on, the phone fold is open).
  await page.getByTestId("audit-filter-clear").click();
  await expect(page).toHaveURL(/\/audit$/);
  // The URL moves before the unfiltered page arrives: wait for it rather than read the old list.
  await expect
    .poll(
      () => events.evaluateAll((els) => new Set(els.map((e) => e.getAttribute("data-actor"))).size),
      { message: "distinct actors after Clear" },
    )
    .toBeGreaterThan(1);
  await expect(page.getByTestId("audit-filter-actor")).toHaveValue("");
  await expectNoHorizontalScroll(page);
});

test("dashboard: the band's focus ring is drawn inside its clipped row (demo data)", async ({
  authed: page,
}) => {
  await page.goto("/dashboard?mock");
  const link = page.getByTestId("fleet").locator(".fleet__link").first();
  await expect(link).toBeVisible();
  // Keyboard focus: tab from the band's "All agents" link onto the first row.
  await page.getByTestId("fleet-manage").focus();
  await page.keyboard.press("Tab");
  await expect(link).toBeFocused();
  const ring = await link.evaluate((el) => {
    const cs = getComputedStyle(el);
    return {
      style: cs.outlineStyle,
      width: Number.parseFloat(cs.outlineWidth),
      offset: Number.parseFloat(cs.outlineOffset),
      visible: el.matches(":focus-visible"),
    };
  });
  expect(ring.visible).toBe(true);
  expect(ring.style).not.toBe("none");
  // The row clips (for the working trace), so the whole ring must sit inside the link's box.
  expect(ring.offset + ring.width).toBeLessThanOrEqual(0);
});

test("dashboard: arrives in place, nothing in the main column shifts while it loads (demo data)", async ({
  authed: page,
}) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __shift: number };
    w.__shift = 0;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as (PerformanceEntry & {
        value: number;
        sources?: { node?: Node | null }[];
      })[]) {
        const inMain = (e.sources ?? []).some(
          (s) => s.node instanceof Element && s.node.closest("main") !== null,
        );
        if (inMain) w.__shift += e.value;
      }
    }).observe({ type: "layout-shift", buffered: true });
  });
  await page.goto("/dashboard?mock");
  await expect(page.getByTestId("repo-list")).toBeVisible();
  await expect(page.getByTestId("dashboard-loading")).toHaveCount(0);
  await page.waitForTimeout(300);
  const shift = await page.evaluate(() => (window as unknown as { __shift: number }).__shift);
  expect(shift, "cumulative layout shift inside main").toBeLessThan(0.02);
});

test("audit: a long agent name stays in its Who column and reads in full on hover", async ({
  authed: page,
  request,
  baseURL,
  human,
}) => {
  const headers = { cookie: human.cookie, origin: baseURL as string };
  const created = await request.post(`${baseURL}/api/v1/repos`, {
    headers,
    data: { name: uniqueName("longname").toLowerCase() },
  });
  expect(created.status(), `create repo: ${await created.text()}`).toBe(201);
  const { repo } = (await created.json()) as { repo: { id: string } };
  // The name a device claim gives an agent before anyone names it (apps/platform/src/claim/principal.ts).
  const name = `Unclaimed agent (tophat-native-${uniqueName("x").toLowerCase()})`;
  const agentRes = await request.post(`${baseURL}/api/v1/principals/agents`, {
    headers,
    data: { name, scopes: ["repo:read", "change:create"] },
  });
  expect(agentRes.status(), `create agent: ${await agentRes.text()}`).toBe(201);
  const { principal, token } = (await agentRes.json()) as {
    principal: { id: string };
    token: string;
  };
  const started = await request.post(`${baseURL}/api/v1/changes`, {
    headers: { authorization: `Bearer ${token}`, origin: baseURL as string },
    data: { repoId: repo.id, title: "Rename the invoice totaller", category: "fix" },
  });
  expect(started.status(), `start change: ${await started.text()}`).toBe(201);

  await page.goto(`/audit?actor=${encodeURIComponent(principal.id)}`);
  const event = page.getByTestId("audit-event").first();
  await expect(event).toBeVisible();
  const link = event.locator(".audit__who-link");
  await expect(link).toHaveAttribute("title", new RegExp(name.replace(/[()]/g, "\\$&")));
  // The name is clipped inside its column: it never paints over What (beside it, or below it on a phone).
  const box = await event.evaluate((row) => {
    const name = (
      row.querySelector(".audit__who .who__name") as HTMLElement
    ).getBoundingClientRect();
    const who = (row.querySelector(".audit__who") as HTMLElement).getBoundingClientRect();
    const what = (row.querySelector(".audit__what") as HTMLElement).getBoundingClientRect();
    const overlaps =
      name.right > what.left &&
      name.left < what.right &&
      name.bottom > what.top &&
      name.top < what.bottom;
    return { nameRight: name.right, whoRight: who.right, overlaps };
  });
  expect(box.nameRight).toBeLessThanOrEqual(box.whoRight + 0.5);
  expect(box.overlaps).toBe(false);
  await expectNoHorizontalScroll(page);
});
