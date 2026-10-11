/**
 * Closing a pull request whose head is still being graded (or whose grading never started, e.g.
 * a workflow lost in a deploy) completes its in-progress `gittifacts/lane` run as cancelled, so it
 * never sits "in progress" forever. A completed run keeps its verdict.
 */
import { CONTRACT_SCENARIOS, contractReviewer, loadFixture } from "@app/host-contract";
import { describe, expect, it } from "vitest";
import { GithubContractHost } from "./github-host.js";

async function opened() {
  const s = CONTRACT_SCENARIOS["pure-bugfix-with-regression-test"]();
  const fx = loadFixture(s.fixture);
  const host = new GithubContractHost(contractReviewer());
  const out = await host.open({ scenario: s, base: fx.base, push: fx.push, title: fx.title });
  return { host, ...out };
}

describe("closing a pull request", () => {
  it("cancels the head's run while it is still in progress", async () => {
    const { host, headSha } = await opened();
    expect(host.gh.laneRun(headSha)?.status).toBe("in_progress");
    host.pull.state = "closed";
    await host.sync.handle(host.gh.pullRequestDelivery("closed", host.pull));
    expect(host.gh.laneRun(headSha)).toMatchObject({
      status: "completed",
      conclusion: "cancelled",
    });
    expect(host.gh.laneRun(headSha)?.output.title).toBe("Closed before grading finished");
  });

  it("leaves a completed run's verdict alone", async () => {
    const { host, headSha } = await opened();
    await host.settle();
    const before = host.gh.laneRun(headSha);
    expect(before?.status).toBe("completed");
    const title = before?.output.title;
    host.pull.state = "closed";
    await host.sync.handle(host.gh.pullRequestDelivery("closed", host.pull));
    expect(host.gh.laneRun(headSha)?.output.title).toBe(title);
  });
});
