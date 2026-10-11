/**
 * What GitHub sees in shadow mode, on the recorded-fixture host: one check run per head, created
 * once and completed once, superseded heads closed, nothing written to the PR but check runs,
 * every token revoked, fork code sandboxed to package registries.
 */
import { CONTRACT_SCENARIOS, contractReviewer, loadFixture } from "@app/host-contract";
import { describe, expect, it } from "vitest";
import { changeIdFor } from "../src/ids.js";
import { GithubContractHost } from "./github-host.js";

async function graded(name: keyof typeof CONTRACT_SCENARIOS, opts: { prWrites?: boolean } = {}) {
  const s = CONTRACT_SCENARIOS[name]();
  const fx = loadFixture(s.fixture);
  const host = new GithubContractHost(contractReviewer(), opts);
  const opened = await host.open({ scenario: s, base: fx.base, push: fx.push, title: fx.title });
  await host.settle();
  return { host, s, fx, ...opened };
}

describe("GitHub shadow mode (recorded fixtures)", () => {
  it("one gittifacts/lane run per head: created in progress, the lane early, completed once, saying report-only", async () => {
    const { host, headSha } = await graded("pure-bugfix-with-regression-test", { prWrites: false });
    const runs = [...host.gh.checkRuns.values()];
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(run).toMatchObject({
      head_sha: headSha,
      name: "gittifacts/lane",
      status: "completed",
      updates: 2,
    });
    // Opened while grading, the classifier's lane while the tour is written (still in progress,
    // no conclusion), then the verdict. Never success before the tour.
    expect(run.history.map((h) => [h.status, h.conclusion])).toEqual([
      ["in_progress", null],
      ["in_progress", null],
      ["completed", "neutral"],
    ]);
    expect(run.history[1]?.title).toBe("Quick review (Lane 1) so far · walkthrough coming");
    expect(run.output.title).toBe("Quick review (Lane 1) · auto-merge is calibrating");
    expect(run.output.summary).toContain("Report-only");
    expect(run).toMatchObject({ details_url: "https://gittifacts.test/changes/gh-9001-1" });
    // With PR writes off, nothing but check runs reaches the PR.
    expect(new Set(host.gh.writes)).toEqual(new Set(["POST check-runs", "PATCH check-runs"]));
    // Every installation token minted for a job was revoked.
    expect(host.gh.tokens.minted).toBeGreaterThan(0);
    expect(host.gh.tokens.revoked).toBe(host.gh.tokens.minted);
    // The mirror fetched with a token; it is a mirror, not a fork per PR.
    expect(
      host.env.ports.git.externalFetches.every((f) => f.authed && f.toRepo === "ghm-9001"),
    ).toBe(true);
    const change = await host.env.ports.store.getChange(changeIdFor(9001, 1));
    expect(change).toMatchObject({
      forkName: "ghm-9001",
      status: "awaiting-review",
      host: { kind: "github", number: 1, fork: false },
    });
  });

  it("a replaced head's run is cancelled, never left in progress", async () => {
    const s = CONTRACT_SCENARIOS["force-push-during-eval"]();
    const fx = loadFixture(s.fixture);
    const first = loadFixture(s.firstFixture ?? s.fixture);
    const host = new GithubContractHost(contractReviewer());
    await host.holdRuns(true);
    const opened = await host.open({
      scenario: s,
      base: fx.base,
      push: first.push,
      title: fx.title,
    });
    await host.settle();
    const head = await host.push(opened.ref, fx.push, { force: true });
    await host.holdRuns(false);
    await host.settle();
    expect(host.gh.laneRun(opened.headSha)).toMatchObject({
      status: "completed",
      conclusion: "cancelled",
    });
    expect(host.gh.laneRun(head)).toMatchObject({ status: "completed", updates: 2 });
    // The replaced head's run was never reopened by an early lane.
    expect(host.gh.laneRun(opened.headSha)?.history.at(-1)).toMatchObject({
      status: "completed",
      conclusion: "cancelled",
    });
  });

  it("fork PRs: untrusted code runs with registries-only egress, read from the base repo", async () => {
    const { host, headSha } = await graded("fork-pr");
    const change = await host.env.ports.store.getChange(changeIdFor(9001, 1));
    expect(change?.host).toMatchObject({ fork: true, headRepo: "outside-contributor/fixture-lib" });
    const run = [...host.env.ports.ci.runs.values()].find((r) => r.request.headSha === headSha);
    expect(run?.request.network).toBe("registries-only");
    expect(host.env.ports.git.externalFetches.map((f) => f.url)).toEqual(
      expect.arrayContaining(["https://github.com/gittifacts-test/fixture-lib.git"]),
    );
  });

  it("merge in shadow mode: a stale head is refused with the new head, a current one is not allowed", async () => {
    const { host, ref, headSha } = await graded("pure-bugfix-with-regression-test");
    expect(
      await host.adapter.merge(ref, { expectedHeadSha: headSha, method: "squash" }),
    ).toMatchObject({
      status: "refused",
      reason: "not-allowed",
    });
    const next = await host.push(ref, { "README.md": "# again\n" }, { force: false });
    expect(
      await host.adapter.merge(ref, { expectedHeadSha: headSha, method: "squash" }),
    ).toMatchObject({
      status: "refused",
      reason: "stale-head",
      currentHeadSha: next,
    });
  });
});
