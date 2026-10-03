/**
 * Journey 6: the merge queue. The human approves three small agent Changes (two edit the same
 * README line, so one needs the resolver), then watches them batch and merge; dead waits are cut.
 * Then a project with deploy trains (state.trainsProjectId) shows merged trains.
 */
import { HOST } from "../lib/journey.js";
import type { HumanJourney } from "../lib/types.js";

const QUEUE_DONE = [
  "merged",
  "released",
  "rolling-out",
  "ejected",
  "failing",
  "rejected",
  "abandoned",
];

export const journey: HumanJourney = {
  number: "06",
  slug: "merge-queue",
  title: "The merge queue: queued, batched, merged",
  subtitle:
    "Approved Changes enter the agent-native queue; only the queue writes main. Waits are cut.",
  signedIn: true,
  async run(j, state) {
    const p = j.page;
    const ids = state.queueChangeIds ?? [];
    if (!state.projectId || ids.length === 0)
      throw new Error("state.projectId / queueChangeIds missing");
    const status = async (id: string): Promise<string> => {
      const r = await p.request.get(`${HOST}/api/v1/changes/${id}`, {
        headers: { accept: "application/json" },
      });
      return ((await r.json()) as { change: { status: string } }).change.status;
    };

    const approveOnPage = async (id: string, opts: { goto?: boolean } = {}) => {
      if (opts.goto !== false)
        await j.goto(`/changes/${id}`, { waitFor: ".decision__title, h1", settleMs: 900 });
      // A resolution asks for "Approve resolution" (the approval is for what the resolver wrote).
      await j.click(p.getByRole("button", { name: /^Approve( resolution)?$/ }).first());
      await j.click(p.getByRole("button", { name: /^Approve (change|resolution)$/ }), {
        pauseMs: 200,
      });
      await p
        .getByText(
          /joins the merge queue|waiting in the merge queue|lands it next|back into the merge queue/,
        )
        .first()
        .waitFor({ timeout: 30_000 });
      await j.hold(700);
    };
    /** The resolution panel: what main had, what the Change had, what lands (resolver lines marked). */
    const showResolution = async (id: string) => {
      await j.goto(`/changes/${id}`, { waitFor: "h1", settleMs: 2600 });
      const panel = p.locator(".resolution").first();
      if ((await panel.count()) > 0) {
        await j.reveal(panel, true);
        await j.hold(2600);
        await j.snap("resolution");
        await j.scroll(420, 1000);
        await j.hold(2600);
        await j.snap("resolution-2");
        await j.scroll(-420, 800);
      } else {
        await j.snap("resolved");
        await j.scroll(500, 1000);
        await j.hold(2200);
        await j.scroll(-500, 800);
      }
    };
    // A Change left awaiting re-approval by the previous round (only if it still is).
    const resolved =
      state.resolvedChangeId && (await status(String(state.resolvedChangeId))) === "awaiting-review"
        ? String(state.resolvedChangeId)
        : null;
    const all = [...(resolved ? [resolved] : []), ...ids];

    await j.chapter(
      "Changes waiting for a person",
      "Docs changes from the agent wait for review (two edit the same README line)",
    );
    await j.goto(`/repos/${state.projectId}`, { waitFor: "h1", settleMs: 2200 });
    await j.snap("repo");
    if (resolved) {
      await j.chapter(
        "A resolved conflict",
        "From the last batch: the resolver merged a conflict; a person re-approves the result",
      );
      await showResolution(resolved);
      await approveOnPage(resolved, { goto: false });
    }
    await j.chapter(
      "Approve three more",
      "Approve the three new ones (each review was shown in journey 4)",
    );
    for (const id of ids) await approveOnPage(id);
    const approvedAt = Date.now();

    await j.chapter("The queue", "The merge queue: tracks, batches and what each Change waits for");
    await j.goto(`/repos/${state.projectId}/queue`, { waitFor: "h1", settleMs: 2500 });
    await j.snap("queue-1");
    await j.hold(2500);
    await j.scroll(450, 900);
    await j.hold(2200);
    await j.scroll(-450, 700);

    // Watch it work: short real-time looks, the waits in between cut. A Change the resolver
    // touched comes back for re-approval: approve it on camera.
    for (let round = 0; round < 14; round++) {
      const states = await Promise.all(all.map(status));
      if (states.every((s) => QUEUE_DONE.includes(s))) break;
      const back = all.find((_id, i) => states[i] === "awaiting-review");
      if (back) {
        await j.chapter(
          "Re-approve a resolution",
          "The resolver merged a conflict in the queue: the page shows what lands; approve the resolution",
        );
        await showResolution(back);
        await approveOnPage(back, { goto: false });
        await j.goto(`/repos/${state.projectId}/queue`, { waitFor: "h1", settleMs: 1800 });
        continue;
      }
      await j.cut("queue running", async () => {
        const before = states.join();
        for (let k = 0; k < 40; k++) {
          await p.waitForTimeout(3000);
          const now = (await Promise.all(all.map(status))).join();
          if (now !== before) return;
        }
      });
      await j.chapter(`Queue: ${(await Promise.all(all.map(status))).join(", ")}`, "");
      await j.hold(2600);
      await j.snap(`queue-round-${round + 1}`);
    }
    j.metrics.approveToAllMergedSec = Math.round((Date.now() - approvedAt) / 1000);
    j.metrics.finalStatuses = (await Promise.all(all.map(status))).join(", ");
    await j.scroll(500, 900);
    await j.hold(2200);
    await j.snap("queue-final");

    await j.chapter(
      "Repository after the merges",
      "Merged: the changes left the review list; main moved",
    );
    await j.goto(`/repos/${state.projectId}`, { waitFor: "h1", settleMs: 1500 });
    const closed = p
      .getByRole("tab", { name: /Closed/ })
      .or(p.getByRole("button", { name: /Closed/ }));
    if ((await closed.count()) > 0) await j.click(closed.first());
    await j.hold(2500);
    await j.snap("repo-closed");

    if (state.trainsProjectId) {
      await j.chapter(
        "Deploy trains",
        "A project with a deploy target: merged Changes leave in deploy trains",
      );
      await j.goto(`/repos/${state.trainsProjectId}/queue`, { waitFor: "h1", settleMs: 2000 });
      const trains = p.locator("#q-trains");
      if ((await trains.count()) > 0) await j.reveal(trains, true);
      await j.hold(2600);
      await j.snap("trains");
      await j.scroll(500, 1000);
      await j.hold(2400);
      await j.snap("trains-2");
    }
  },
};
