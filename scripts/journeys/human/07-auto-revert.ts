/**
 * Journey 7: regression → auto-revert, after the fact. The M4 run's bad Change
 * (state.revertedChangeId) threw for 40% of traffic behind its flag; the platform detected it,
 * switched the flag off, rolled back and merged a verified revert, with no human.
 */
import type { HumanJourney } from "../lib/types.js";

export const journey: HumanJourney = {
  number: "07",
  slug: "auto-revert",
  title: "Regression → automatic rollback and revert",
  subtitle:
    "A merged Change threw for 40% of traffic. Detected, flag off, rolled back, reverted: no human.",
  signedIn: true,
  async run(j, state) {
    const p = j.page;
    const id = state.revertedChangeId;
    if (!id) throw new Error("state.revertedChangeId missing");

    await j.chapter("The reverted Change", "The Change that caused the regression: reverted");
    await j.goto(`/changes/${id}`, { waitFor: "h1", settleMs: 2800 });
    await j.snap("change");
    await j.scroll(450, 900);
    await j.hold(2200);
    await j.scroll(-450, 700);

    await j.chapter(
      "Rollout timeline",
      "The rollout: stages, health, and the timeline of what happened",
    );
    const link = p.locator(`a[href='/changes/${id}/rollout']`).first();
    if ((await link.count()) > 0) await j.click(link);
    else await j.goto(`/changes/${id}/rollout`);
    await p.waitForURL(/\/rollout/);
    await p.waitForLoadState("networkidle").catch(() => {});
    await j.hold(2800);
    await j.snap("rollout-top");
    for (const sel of ["#health-title", "#kill-title", "#timeline-title", "#issues-title"]) {
      const loc = p.locator(sel).first();
      if ((await loc.count()) === 0) continue;
      await j.reveal(loc, true);
      await j.hold(sel === "#timeline-title" ? 1800 : 2600);
      await j.snap(`rollout-${sel.slice(1)}`);
      if (sel === "#timeline-title") {
        for (let i = 0; i < 3; i++) {
          await j.scroll(380, 1100);
          await j.hold(2200);
        }
        await j.snap("rollout-timeline-2");
      }
    }

    await j.chapter(
      "The revert",
      "The revert Change: verified pure (identical tree), merged in Lane 0",
    );
    const rv = p.locator(`a[href='/changes/rv-${id}']`).first();
    if ((await rv.count()) > 0) await j.click(rv);
    else await j.goto(`/changes/rv-${id}`);
    await p.waitForURL(/\/changes\/rv-/);
    await p.waitForLoadState("networkidle").catch(() => {});
    await j.hold(2800);
    await j.snap("revert");
    await j.scroll(500, 1000);
    await j.hold(2400);
    await j.snap("revert-2");
  },
};
