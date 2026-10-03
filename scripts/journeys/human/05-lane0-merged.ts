/**
 * Journey 5: a Lane 0 Change merged with no human. The live example is the platform's own
 * verified pure revert from the M4 run (state.lane0ChangeId, e.g. rv-<change>): what does a person
 * see afterwards? The change page, its evidence and signature (the signed git note), the audit trail.
 */
import type { HumanJourney } from "../lib/types.js";

export const journey: HumanJourney = {
  number: "05",
  slug: "lane0-merged",
  title: "A Lane 0 Change that merged with no human",
  subtitle:
    "The platform's verified pure revert merged itself in Lane 0. What a person sees afterwards.",
  signedIn: true,
  async run(j, state) {
    const p = j.page;
    const id = state.lane0ChangeId;
    if (!id) throw new Error("state.lane0ChangeId missing");

    await j.chapter("The change page", "A Change no person reviewed: why it was allowed to merge");
    j.metrics.changePageMs = await j.goto(`/changes/${id}`, { waitFor: "h1", settleMs: 2800 });
    await j.snap("change-top");
    await j.moveTo(600, 220);
    await j.hold(1500);
    await j.scroll(500, 1000);
    await j.hold(2400);
    await j.snap("change-2");
    await j.scroll(600, 1000);
    await j.hold(2400);
    await j.snap("change-3");

    await j.chapter("Why Lane 0", "Why Lane 0: the signals that allowed auto-merge");
    const lane = p.locator("[id^='lane-title']").first();
    if ((await lane.count()) > 0) {
      await j.reveal(lane, true);
      await j.hold(2600);
      await j.scroll(450, 900);
      await j.hold(2400);
      await j.snap("lane");
    }

    await j.chapter(
      "Evidence and signature",
      "The evidence and its Ed25519 signature (also stored as a git note)",
    );
    const ev = p.locator(`a[href='/changes/${id}/evidence']`).first();
    if ((await ev.count()) > 0) await j.click(ev);
    else await j.goto(`/changes/${id}/evidence`);
    await p.waitForURL(/\/evidence/);
    await p.waitForLoadState("networkidle").catch(() => {});
    await j.hold(2600);
    await j.snap("evidence-top");
    const attest = p.locator("#attest-title");
    if ((await attest.count()) > 0) {
      await j.reveal(attest, true);
      await j.hold(3200);
      await j.snap("attestation");
    }
    await j.scroll(900, 1400);
    await j.hold(2000);
    await j.scroll(900, 1400);
    await j.hold(2000);
    await j.snap("evidence-more");

    await j.chapter("Audit trail", "The audit trail of this Change: every step, hash-chained");
    await j.goto(`/audit?subject=${encodeURIComponent(`change:${id}`)}`, {
      waitFor: "h1",
      settleMs: 2600,
    });
    await j.snap("audit");
    await j.scroll(500, 1000);
    await j.hold(2400);
    const row = p
      .locator("tbody tr, .audit-row, li")
      .filter({ hasText: /merged|Merged/ })
      .first();
    if ((await row.count()) > 0) {
      await j.reveal(row, true);
      const expand = row.locator("button").first();
      if ((await expand.count()) > 0) {
        await j.click(expand);
        await j.hold(2600);
      }
    }
    await j.snap("audit-2");
  },
};
