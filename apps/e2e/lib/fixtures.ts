/**
 * The test fixture every E2E spec imports instead of @playwright/test:
 *
 * - `human`: a fresh account (signed up through better-auth); `world`: its seeded repo, Plan and
 *   Change (gate only); `authed`: a page whose browser context carries the human's session.
 * - A guard on every page: an uncaught page error or a 5xx from the platform fails the test, even
 *   when the visible assertions passed (the "button that did nothing" class of regression).
 * - Quarantine (quarantine.json): a listed test is skipped with its owner and reason until its
 *   expiry date; after that it fails, so a quarantine can never become permanent by neglect.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test as base, expect, type Page } from "@playwright/test";
import { z } from "zod";
import { pollUntil } from "./poll.js";
import { type AgentChange, agentChange, type Human, seedWorld, signInContext, signUp, type World } from "./world.js";

const Quarantine = z.array(
  z.object({
    /** Substring of the test's full title ("file › describe › test"). */
    test: z.string().min(3),
    owner: z.string().min(1),
    reason: z.string().min(1),
    /** ISO date (YYYY-MM-DD); at most 14 days out. */
    expires: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
);

const quarantine = Quarantine.parse(
  JSON.parse(readFileSync(join(import.meta.dirname, "..", "quarantine.json"), "utf8")),
);

interface Fixtures {
  human: Human;
  world: World;
  /** A Change an agent pushed through the real pipeline (gate only). */
  agentWork: AgentChange;
  authed: Page;
  pageGuard: void;
  quarantined: void;
}

export const test = base.extend<Fixtures>({
  quarantined: [
    async ({}, use, testInfo) => {
      const title = testInfo.titlePath.join(" › ");
      const q = quarantine.find((e) => title.includes(e.test));
      if (q !== undefined) {
        if (new Date(`${q.expires}T23:59:59Z`).getTime() < Date.now()) {
          throw new Error(`quarantine for "${q.test}" expired on ${q.expires} (owner ${q.owner}): fix or re-justify it`);
        }
        testInfo.annotations.push({ type: "quarantined", description: `${q.owner} until ${q.expires}: ${q.reason}` });
        testInfo.skip(true, `quarantined (${q.owner}, until ${q.expires}): ${q.reason}`);
      }
      await use();
    },
    { auto: true },
  ],
  pageGuard: [
    async ({ page }, use) => {
      const problems: string[] = [];
      page.on("pageerror", (err) => problems.push(`page error: ${err.message}`));
      page.on("response", (res) => {
        if (res.status() >= 500 && new URL(res.url()).origin === new URL(page.url() || res.url()).origin) {
          problems.push(`HTTP ${res.status()} ${res.request().method()} ${new URL(res.url()).pathname}`);
        }
      });
      await use();
      expect(problems, "uncaught page errors or platform 5xx during the test").toEqual([]);
    },
    { auto: true },
  ],
  human: async ({ request, baseURL }, use, testInfo) => {
    await use(await signUp(request, baseURL as string, `e2e-${testInfo.project.name}`));
  },
  world: async ({ request, baseURL, human }, use, testInfo) => {
    await use(await seedWorld(request, baseURL as string, human, `w-${testInfo.project.name}`));
  },
  agentWork: async ({ request, baseURL, human }, use) => {
    await use(await agentChange(request, baseURL as string, human, (probe, done, what) => pollUntil(probe, done, { timeoutMs: 45_000, what })));
  },
  authed: async ({ page, context, baseURL, human }, use) => {
    await signInContext(context, baseURL as string, human);
    await use(page);
  },
});

export { expect };

/** At phone width nothing may scroll sideways (the layout's one hard rule at 390 px). */
export async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const el = document.scrollingElement ?? document.documentElement;
    return el.scrollWidth - el.clientWidth;
  });
  expect(overflow, "horizontal overflow in px").toBeLessThanOrEqual(1);
}
