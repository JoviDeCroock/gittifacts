/**
 * Journey 13: a brand-new account, from the landing page to its first green check through the
 * dashboard's getting-started checklist. Signs up a fresh human (unique e-mail per take), so it
 * changes live state: one account and one static-site project per run. Measures sign-up → dashboard,
 * "Create project" → green, and sign-up → green; then checks `/` stays the landing page with
 * "Open dashboard" in its nav.
 */
import type { HumanJourney } from "../lib/types.js";

export const journey: HumanJourney = {
  number: "13",
  slug: "dashboard",
  title: "New account: sign up, dashboard, first green",
  subtitle: "A person signs up and gets a green check and a live preview from the checklist.",
  mobile: true,
  async run(j) {
    const p = j.page;
    const stamp = Date.now().toString(36);
    await j.chapter("Landing page", "Signed out: the landing page");
    await j.goto("/", { waitFor: "h1", settleMs: 1400 });
    await j.snap("landing-signed-out");

    await j.chapter("Create an account");
    await j.click(p.locator("a.hero__cta[href='/signin?mode=signup']").first());
    await p.waitForSelector("input[name='name']", { timeout: 20_000 });
    await j.type("input[name='name']", "Journey Thirteen");
    await j.type("input[name='email']", `journey13-${stamp}@example.com`);
    await j.type("input[name='password']", `j13-${stamp}-password!`);
    const signupAt = Date.now();
    await j.click(p.locator("form.signin__form button[type='submit']").first());
    await p.waitForURL(/\/dashboard$/, { timeout: 30_000 });
    await p.waitForSelector(".gs", { timeout: 30_000 });
    j.metrics.signupToDashboardMs = Date.now() - signupAt;
    j.notes.push(`title after sign-up: ${await p.title()}`);
    await j.hold(1500);
    await j.snap("dashboard-new");

    await j.chapter("Try it now", "Try it now: a project from a template");
    const create = p.getByRole("button", { name: "Create repo" });
    await j.reveal(create);
    const createAt = Date.now();
    await j.click(create);
    await p.waitForSelector(".gs-step[data-state='running']", { timeout: 30_000 });
    await j.hold(1200);
    await j.snap("try-running");
    await j.caption("The first check runs; the step ticks itself off", 3000);
    await p.waitForSelector(".gs-green, .gs-step__line--failed", { timeout: 300_000 });
    const greenAt = Date.now();
    const failed = (await p.locator(".gs-step__line--failed").count()) > 0;
    j.metrics.createToGreenMs = greenAt - createAt;
    j.metrics.signupToGreenMs = greenAt - signupAt;
    j.notes.push(failed ? "first run FAILED" : `green line: ${await p.locator(".gs-green").innerText()}`);
    await j.hold(1500);
    await j.snap("try-green");

    const preview = p.locator(".gs-green a.gs-ext").first();
    if (!failed && (await preview.count()) > 0) {
      const href = (await preview.getAttribute("href")) ?? "";
      j.notes.push(`preview: ${href}`);
      await j.chapter("The preview");
      await p.goto(href, { waitUntil: "domcontentloaded" }).catch(() => {});
      await j.hold(2500);
      await j.snap("preview");
    }

    await j.chapter("Back on the landing page", "Signed in, / is still the landing page");
    await j.goto("/", { waitFor: "h1", settleMs: 1800 });
    const nav = p.locator("a.topbar__signin").first();
    j.notes.push(`landing nav: ${(await nav.innerText()).trim()} → ${await nav.getAttribute("href")}`);
    await j.snap("landing-signed-in");
    await j.click(nav);
    await p.waitForURL(/\/dashboard$/, { timeout: 20_000 });
    await p.waitForSelector("h1", { timeout: 20_000 });
    await j.hold(1500);
    await j.snap("dashboard-after");
  },
};
