/** Journey 9: a person follows the docs: "Migrate from GitHub", then the CI guide it links to. */
import type { HumanJourney } from "../lib/types.js";

export const journey: HumanJourney = {
  number: "09",
  slug: "docs-migrate-ci",
  title: "Docs: migrate from GitHub, then configure CI",
  subtitle:
    "A team lead plans the move off GitHub: the migration guide, then the CI guide it points to.",
  async run(j) {
    const p = j.page;
    await j.chapter("Docs home", "The docs home");
    await j.goto("/docs", { waitFor: "h1", settleMs: 1800 });
    await j.snap("docs-home");

    await j.chapter(
      "Migrate from GitHub",
      "“Migrate from GitHub”: import, check history, detection, cut-over",
    );
    const nav = p
      .locator(
        "nav a[href='/docs/guides/migrate-from-github'], aside a[href='/docs/guides/migrate-from-github']",
      )
      .first();
    const link =
      (await nav.count()) > 0 ? nav : p.getByRole("link", { name: /Migrate from GitHub/ }).first();
    await j.click(link);
    await p.waitForURL(/migrate-from-github/);
    await p.waitForLoadState("networkidle").catch(() => {});
    await j.hold(2600);
    await j.snap("migrate-top");
    const headings = p.locator("main h2");
    const n = await headings.count();
    for (let i = 0; i < n; i++) {
      const text = ((await headings.nth(i).textContent()) ?? "").trim();
      await j.reveal(headings.nth(i), true);
      await j.hold(text.startsWith("1.") || text.startsWith("3.") ? 3200 : 2400);
      await j.snap(`migrate-h2-${i + 1}`);
      if (text.startsWith("1.")) {
        // The first command block: copy it, as a person following along would.
        const copy = p.locator("main pre").first().locator("xpath=..").getByRole("button").first();
        if ((await copy.count()) > 0) await j.click(copy, { pauseMs: 900 });
      }
    }

    await j.chapter("Configure CI", "From the GitHub Actions row: the CI guide");
    const ci = p.locator("main a[href='/docs/guides/configure-ci']").first();
    await j.reveal(ci, true);
    await j.hold(1200);
    await j.click(ci);
    await p.waitForURL(/configure-ci/);
    await p.waitForLoadState("networkidle").catch(() => {});
    await j.hold(2600);
    await j.snap("ci-top");
    const h2 = p.locator("main h2");
    const m = Math.min(await h2.count(), 7);
    for (let i = 0; i < m; i++) {
      await j.reveal(h2.nth(i), true);
      await j.hold(2300);
      await j.snap(`ci-h2-${i + 1}`);
    }

    await j.chapter("Search", "Search the docs: “lane 0”");
    await j.scroll(-20000, 1000);
    const search = p.getByPlaceholder(/Search docs/).first();
    if ((await search.count()) > 0) {
      await j.type(search, "lane 0", 90);
      await j.hold(2400);
      await j.snap("search");
    }
  },
};
