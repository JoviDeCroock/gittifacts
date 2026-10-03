/** Journey 3: an agent drafted a Plan; the human finds it, reads it and approves it. */
import type { HumanJourney } from "../lib/types.js";

export const journey: HumanJourney = {
  number: "03",
  slug: "plan-approval",
  title: "Approve an agent's Plan",
  subtitle:
    "The agent drafted a Plan (intent, acceptance criteria, scope). Only a person can approve intent.",
  signedIn: true,
  async run(j, state) {
    const p = j.page;
    if (!state.projectId || !state.planId)
      throw new Error("state.projectId / state.planId missing");

    await j.chapter("Dashboard", "Signed in: which repository needs me?");
    await j.goto("/dashboard", { waitFor: "h1", settleMs: 1800 });
    await j.snap("repos");
    const row = p.locator(`a.repo-row[href='/repos/${state.projectId}']`).first();
    await j.reveal(row);
    await j.hold(1200);

    await j.chapter("The repository", "The repository: a Plan waits for approval");
    await j.click(row);
    await p.waitForURL(new RegExp(`/repos/${state.projectId}`));
    await p.waitForLoadState("networkidle").catch(() => {});
    await j.hold(2200);
    await j.snap("repo");

    await j.chapter(
      "Read the Plan",
      "The Plan: intent, acceptance criteria, out of scope, scope paths",
    );
    const link = p.locator(`a[href='/plans/${state.planId}']`).first();
    if ((await link.count()) > 0) await j.click(link);
    else await j.goto(`/plans/${state.planId}`);
    await p.waitForSelector("#intent", { timeout: 20_000 });
    await j.hold(2600);
    await j.snap("plan");
    await j.moveTo(520, 300);
    await j.hold(1500);
    await j.reveal(p.locator("#criteria"), true);
    await j.hold(2600);
    await j.reveal(p.locator("#oos"), true);
    await j.hold(2000);
    await j.scroll(500, 900);
    await j.hold(1800);
    await j.snap("plan-scope");
    await j.scroll(-1400, 1200);
    await j.hold(600);

    await j.chapter("Sign and approve", "Approve: confirm you read it, add a comment, sign");
    await j.click(p.getByRole("checkbox").first());
    await j.type(
      p.getByLabel(/Comment/),
      "Load once on start is right. Keep the button as the manual refresh.",
      25,
    );
    await j.snap("plan-ready");
    const started = Date.now();
    await j.click(p.getByRole("button", { name: "Sign and approve" }), { pauseMs: 200 });
    await p
      .getByText(/Approved/)
      .first()
      .waitFor({ timeout: 20_000 });
    j.metrics.approveMs = Date.now() - started;
    await j.hold(2400);
    await j.snap("plan-approved");
    await j.scroll(700, 1200);
    await j.hold(2000);
    await j.snap("plan-approved-2");

    await j.chapter("Audit log", "The approval is signed and in the audit log");
    await j.goto(`/audit`, { waitFor: "h1", settleMs: 2500 });
    await j.snap("audit");
  },
};
