/** Journey 1: a first visit, signed out: landing → scroll → docs → /start. */
import type { HumanJourney } from "../lib/types.js";

export const journey: HumanJourney = {
  number: "01",
  slug: "first-visit",
  title: "First visit: landing, docs, /start",
  subtitle: "A developer hears about gittifacts and opens the site, signed out.",
  mobile: true,
  async run(j, _state, { mobile }) {
    const p = j.page;
    await j.chapter("Landing page", "A first visit: the landing page");
    j.metrics.landingLoadMs = await j.goto("/", { waitFor: "h1", settleMs: 2200 });
    await j.snap("landing-top");

    await j.chapter("Scroll the page", "Scroll: the shift, the loop, migrate, agents, rules");
    const sections = ["#shift-title", "#loop", "#migrate", "#agents", "#rules", "#close-title"];
    for (const s of sections) {
      const loc = p.locator(s).first();
      if ((await loc.count()) === 0) continue;
      await j.reveal(loc, true);
      await j.hold(mobile ? 1600 : 1900);
      await j.snap(`section-${s.replace(/\W/g, "")}`);
    }
    await j.scroll(2400, 1600);
    await j.hold(900);
    await j.snap("footer");

    await j.chapter("Docs", "The footer links to the docs");
    await j.click(p.locator("footer a[href='/docs']").first());
    await p.waitForURL(/\/docs\/?$/, { timeout: 15_000 });
    await p.waitForLoadState("networkidle").catch(() => {});
    await j.hold(1800);
    await j.snap("docs-home");
    await j.scroll(700, 1200);
    await j.hold(1200);
    await j.snap("docs-home-2");
    // The "get started for humans" page, as a person would open first.
    const start = p.getByRole("link", { name: /Get started for humans/ }).first();
    if ((await start.count()) > 0) {
      await j.chapter("Docs: get started for humans");
      await j.click(start);
      await p.waitForLoadState("networkidle").catch(() => {});
      await j.hold(1800);
      await j.snap("docs-get-started");
      await j.scroll(900, 1400);
      await j.hold(1400);
      await j.scroll(900, 1400);
      await j.hold(1200);
    }

    await j.chapter("/start (the machine guide)", "/start: the front door written for agents");
    const res = await p
      .goto(`${new URL(p.url()).origin}/start`, { waitUntil: "domcontentloaded" })
      .catch((e: unknown) => {
        j.notes.push(`/start navigation: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      });
    j.notes.push(`/start content-type: ${res?.headers()["content-type"] ?? "(download or none)"}`);
    await j.hold(2200);
    await j.snap("start");
    await j.scroll(800, 1500);
    await j.hold(1500);
    await j.scroll(800, 1500);
    await j.hold(1500);
    await j.snap("start-2");
  },
};
