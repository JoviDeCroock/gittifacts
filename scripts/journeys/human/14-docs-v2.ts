/**
 * Journey 14: a newcomer opens the docs home and follows the quickest getting-started path to its
 * first command. Recorded before and after the docs rework (docs/ux-review/docs-audit-2026-10-03.md),
 * so it only relies on what both versions share: the home at /docs and the CLI path at
 * /docs/get-started/cli.
 */
import type { HumanJourney } from "../lib/types.js";

const PATH = "/docs/get-started/cli";

export const journey: HumanJourney = {
  number: "14",
  slug: "docs-v2",
  title: "Docs: the front door, then the quickest path",
  subtitle:
    "A developer who heard about gittifacts: docs home, then the 2-minute path to a green check.",
  mobile: true,
  async run(j, _state, { mobile }) {
    const p = j.page;
    await j.chapter("Docs home", "The docs home: where do I start?");
    await j.goto("/docs", { waitFor: "h1", settleMs: 2200 });
    await j.snap("home-top");
    // Read down the home the way a newcomer scans it: one screen at a time.
    for (let i = 0; i < (mobile ? 3 : 2); i++) {
      await j.scroll(mobile ? 640 : 560, 900);
      await j.hold(1800);
    }
    await j.snap("home-scrolled");
    await j.scroll(-20000, 700);

    await j.chapter("Quickest path", "Follow the quickest getting-started path");
    const link = p.locator(`main a[href='${PATH}']`).first();
    await j.reveal(link, true);
    await j.hold(1200);
    await j.click(link);
    await p.waitForURL(new RegExp(`${PATH}$`));
    await p.waitForLoadState("networkidle").catch(() => {});
    await j.hold(2600);
    await j.snap("path-top");

    await j.chapter("First command", "Scroll to the first command and copy it");
    const code = p.locator("main .code").first();
    await j.reveal(code, true);
    await j.hold(1600);
    const copy = code.getByRole("button", { name: /copy/i }).first();
    if ((await copy.count()) > 0) await j.click(copy, { pauseMs: 900 });
    await j.snap("first-command");

    await j.chapter("The rest of the path", "Read the steps to the first success");
    const headings = p.locator("main h2");
    const n = Math.min(await headings.count(), 7);
    for (let i = 0; i < n; i++) {
      await j.reveal(headings.nth(i), true);
      await j.hold(1900);
    }
    await j.snap("path-end");
  },
};
