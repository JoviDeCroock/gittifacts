/**
 * Journey 4: review a Change an agent pushed: the tour's stops, the evidence (screenshots, test
 * run, lane reasons), then approve. Desktop: the Lane 1 change under the approved plan; phone:
 * the agent's planless Lane 2 change (state.reviewChangeId / reviewChangeIdMobile).
 */
import type { HumanJourney } from "../lib/types.js";

export const journey: HumanJourney = {
  number: "04",
  slug: "review-change",
  title: "Review a Change: walkthrough, evidence, approve",
  subtitle:
    "An agent pushed a Change. The reviewer agent wrote a walkthrough; the platform signed the evidence.",
  mobile: true,
  signedIn: true,
  async run(j, state, { mobile }) {
    const p = j.page;
    const id = mobile ? state.reviewChangeIdMobile : state.reviewChangeId;
    if (!id || !state.projectId)
      throw new Error("state.reviewChangeId(Mobile) / projectId missing");

    await j.chapter(
      "Changes to review",
      "The repository: changes waiting for a person, grouped by lane",
    );
    await j.goto(`/repos/${state.projectId}`, { waitFor: "h1", settleMs: 2000 });
    await j.snap("repo");
    const row = p.locator(`a[href='/changes/${id}']`).first();
    await j.reveal(row);
    await j.hold(1200);
    await j.click(row);
    await p.waitForURL(new RegExp(`/changes/${id}`));
    await p.waitForSelector(".stop__title", { timeout: 30_000 });
    await j.hold(2400);
    await j.snap("tour-top");

    await j.chapter(
      "What the reviewer agent is unsure about",
      "The walkthrough opens with what the reviewer agent is least sure of",
    );
    const handover = p.locator("#handover-title");
    await j.reveal(handover, true);
    await j.hold(mobile ? 3000 : 2500);

    const stops = p.locator(".stop__title");
    const n = await stops.count();
    j.metrics.tourStops = n;
    for (let i = 0; i < n; i++) {
      const title = ((await stops.nth(i).textContent()) ?? "").trim();
      await j.chapter(`Walkthrough: ${title.replace(/^Stop \d+ of \d+:\s*/, "")}`.slice(0, 90), "");
      await j.reveal(stops.nth(i), true);
      await j.hold(mobile ? 1800 : 2000);
      await j.snap(`stop-${i + 1}`);
      // Screenshots and diffs sit under the title: show them too.
      await j.scroll(mobile ? 520 : 420, 900);
      await j.hold(1200);
    }
    await j.scroll(700, 1000);
    await j.hold(1500);
    await j.snap("tour-end");

    await j.chapter(
      "Why this lane",
      "Why this lane: every signal, with the ones that raised it first",
    );
    const lane = p.locator("[id^='lane-title']").first();
    if ((await lane.count()) > 0) {
      await j.reveal(lane, true);
      await j.hold(1200);
      // On phones "Why Lane N" (a <details>) starts collapsed.
      const details = p.locator("details.lane-block__why").first();
      if ((await details.count()) > 0 && (await details.getAttribute("open")) === null) {
        await j.click(details.locator("summary"));
      }
      await j.hold(1800);
      await j.scroll(mobile ? 600 : 400, 900);
      await j.hold(2200);
      await j.snap("lane");
    }

    await j.chapter("Evidence", "The evidence: signed items, test run, coverage, screenshots");
    const ev = p.locator(`a.ctx-link[href='/changes/${id}/evidence']`).first();
    if ((await ev.count()) > 0) await j.click(ev);
    else await j.goto(`/changes/${id}/evidence`);
    await p.waitForURL(/\/evidence/);
    await p.waitForLoadState("networkidle").catch(() => {});
    await j.hold(2500);
    await j.snap("evidence");
    const anchors = mobile
      ? ["#ev-test-run", "#ev-screenshots"]
      : ["#ev-test-run", "#ev-coverage", "#ev-mutation", "#ev-screenshots"];
    for (const anchor of anchors) {
      const loc = p.locator(anchor).first();
      if ((await loc.count()) === 0) continue;
      await j.reveal(loc, true);
      await j.hold(mobile ? 1500 : 1800);
      await j.snap(`evidence-${anchor.slice(4)}`);
    }
    if (!mobile) {
      await j.scroll(4000, 1500);
      await j.hold(2200);
      await j.snap("evidence-signature");
    }

    await j.chapter("Approve", "Back to the change: approve, say which lane you would have picked");
    await p.goBack();
    await p.waitForSelector(".stop__title", { timeout: 30_000 });
    await j.hold(600);
    await j.scroll(-6000, 1200);
    const approve = p.getByRole("button", { name: "Approve", exact: true });
    await j.click(approve);
    await j.hold(600);
    await j.type(
      p.getByLabel(/Comment for/),
      mobile
        ? "Fine: reset is what we wanted."
        : "Looks right. A test for the startup load would be nice next.",
      22,
    );
    const pick = p
      .locator(".lane-pick")
      .getByRole("radio", { name: mobile ? /Full review/ : /Quick review/ });
    if ((await pick.count()) > 0) await j.click(pick.first());
    await j.snap("approve-form");
    const started = Date.now();
    await j.click(p.getByRole("button", { name: "Approve change" }), { pauseMs: 200 });
    await p
      .getByText(/joins the merge queue|waiting in the merge queue|lands it next/)
      .first()
      .waitFor({ timeout: 30_000 });
    j.metrics.approveMs = Date.now() - started;
    await j.hold(2500);
    await j.snap("approved");
  },
};
