/**
 * M3 on recorded fixtures: the tour as one PR review per head (stale + minimized when replaced),
 * the summary comment edited only on change, approvals from GitHub reviews and the check run's
 * buttons (write access, not the author, humans only), and every write through the governor.
 */
import { CONTRACT_SCENARIOS, contractReviewer, loadFixture } from "@app/host-contract";
import { describe, expect, it } from "vitest";
import { changeIdFor } from "../src/ids.js";
import { GithubContractHost } from "./github-host.js";

const MAINT = { login: "maint-1", id: 6001, type: "User" };

async function lane1(labels?: string[]) {
  const s = CONTRACT_SCENARIOS["pure-bugfix-with-regression-test"]();
  const fx = loadFixture(s.fixture);
  const host = new GithubContractHost(contractReviewer());
  if (labels !== undefined) host.prLabels = labels;
  const opened = await host.open({ scenario: s, base: fx.base, push: fx.push, title: fx.title });
  await host.settle();
  return { host, s, fx, ...opened, changeId: changeIdFor(9001, 1) };
}

const WALKTHROUGH = ["gittifacts:fix", "gittifacts:walkthrough"];

describe("what reaches the PR", () => {
  it("by default: the check run and one summary comment, nothing else", async () => {
    const { host } = await lane1();
    expect(host.gh.reviews.size).toBe(0);
    // Opened, the lane early, the verdict; then the one comment.
    expect(host.gh.writes).toEqual(["POST check-runs", "PATCH check-runs", "PATCH check-runs", "POST issue comment"]);
    const comments = [...host.gh.comments.values()];
    expect(comments).toHaveLength(1);
    const body = comments[0]?.body ?? "";
    // The headline: lane and why, what a person does, the walkthrough; the rest folded.
    const top = body.split("<details>")[0]!.trim().split("\n").slice(1);
    expect(top.length).toBeLessThanOrEqual(5);
    expect(top[0]).toBe("**Quick review (Lane 1)** · the evidence says auto-merge, but auto-merge is still calibrating on this repo.  ");
    expect(top.at(-1)).toBe("[Open the walkthrough on gittifacts](https://gittifacts.test/changes/gh-9001-1): 2 stops, 1 worth a look.");
    expect(body).toMatch(/<details><summary>Why, Plan and approvals<\/summary>[\s\S]*\*\*Plan\*\*: Fix allocate[\s\S]*`gittifacts:walkthrough` label[\s\S]*Report-only[\s\S]*<\/details>$/);
    // No tables (they overflow a phone), no mentions (an edit that adds one notifies).
    expect(body).not.toMatch(/^\|/m);
  });

  it("a new push edits the summary and the check run in place and posts nothing new", async () => {
    const { host, ref, fx } = await lane1();
    const before = host.gh.writes.length;
    const path = "test/allocate.test.ts";
    const second = await host.push(ref, { [path]: `${fx.head[path] ?? ""}// again\n` }, { force: false });
    await host.settle();
    // The new commit's run opens, the old one is closed as replaced, the summary says "grading"
    // (an edit: no notification), the lane early, the verdict, the summary again.
    expect(host.gh.writes.slice(before)).toEqual(["POST check-runs", "PATCH check-runs", "PATCH issue comment", "PATCH check-runs", "PATCH check-runs", "PATCH issue comment"]);
    expect(host.gh.comments.size).toBe(1);
    expect([...host.gh.comments.values()][0]?.body).toContain(second.slice(0, 7));
  });
});

describe("the flagged stops on the diff, on request", () => {
  it("the walkthrough label: one COMMENT review with only the flagged stops (≤ 3), below the summary", async () => {
    const { host, headSha } = await lane1(WALKTHROUGH);
    const reviews = [...host.gh.reviews.values()];
    expect(reviews).toHaveLength(1);
    const r = reviews[0]!;
    expect(r).toMatchObject({ commit_id: headSha, event: "COMMENT", minimized: false });
    // The contract tour has an intent stop (no line) and a risk stop: only the risk goes inline.
    expect(r.comments).toHaveLength(1);
    expect(r.comments[0]?.body).toMatch(/^\*\*Risk\*\* · Riskiest hunk/);
    expect(r.comments[0]?.body).toContain("Stop 2 of 2 in the [walkthrough](https://gittifacts.test/changes/gh-9001-1#stop-2)");
    // The summary is written first, so it sits above the review in the timeline.
    expect(host.gh.writes).toEqual(["POST check-runs", "PATCH check-runs", "PATCH check-runs", "POST issue comment", "POST reviews"]);
    expect(r.body.split("\n")).toHaveLength(1);
    expect(r.body).toContain("1 spot worth a look");
    expect([...host.gh.comments.values()][0]?.body).toContain("2 stops, 1 worth a look (marked on the diff).");
  });

  it("a new head minimizes the old review and its stops (no rewrites) and posts the new one", async () => {
    const { host, ref, headSha: first, fx } = await lane1(WALKTHROUGH);
    const path = "test/allocate.test.ts";
    const second = await host.push(ref, { [path]: `${fx.head[path] ?? ""}// again\n` }, { force: false });
    await host.settle();
    const [old, fresh] = [...host.gh.reviews.values()];
    expect(old).toMatchObject({ commit_id: first, minimized: true });
    expect(old?.comments.every((c) => c.minimized && c.body.startsWith("**Risk**"))).toBe(true);
    expect(host.gh.writes.filter((w) => w === "PUT review" || w === "PATCH review comment")).toEqual([]);
    expect(fresh).toMatchObject({ commit_id: second, minimized: false });
    const summary = [...host.gh.comments.values()];
    expect(summary).toHaveLength(1);
    // A redelivered head changes nothing: no new review, no summary edit.
    const edits = summary[0]?.edits ?? 0;
    const writes = host.gh.writes.length;
    await host.sync.handle(host.gh.pullRequestDelivery("synchronize", host.pull, first));
    await host.settle();
    expect(host.gh.reviews.size).toBe(2);
    expect(summary[0]?.edits).toBe(edits);
    expect(host.gh.writes.slice(writes).filter((w) => !w.includes("check-runs"))).toEqual([]);
  });

  it("adding the label after grading posts the stops for the current head, once", async () => {
    const { host } = await lane1();
    expect(host.gh.reviews.size).toBe(0);
    host.pull.labels = WALKTHROUGH;
    await host.sync.handle(host.gh.editDelivery(host.pull, "labeled"));
    await host.settle();
    expect(host.gh.reviews.size).toBe(1);
    expect([...host.gh.comments.values()][0]?.body).toContain("(marked on the diff)");
    await host.sync.handle(host.gh.editDelivery(host.pull, "labeled"));
    await host.settle();
    expect(host.gh.reviews.size).toBe(1);
  });

  it("with PR writes off, nothing but the check run reaches the PR", async () => {
    const s = CONTRACT_SCENARIOS["pure-bugfix-with-regression-test"]();
    const fx = loadFixture(s.fixture);
    const host = new GithubContractHost(contractReviewer(), { prWrites: false });
    await host.open({ scenario: s, base: fx.base, push: fx.push, title: fx.title });
    await host.settle();
    expect(host.gh.reviews.size).toBe(0);
    expect(host.gh.comments.size).toBe(0);
  });
});

describe("approvals from GitHub map to the platform's record", () => {
  it("a maintainer's review approves; the summary says so; the author, a bot and a reader don't count", async () => {
    const { host, headSha, changeId } = await lane1();
    host.gh.permissions.set("reader-1", "read");
    for (const user of [host.pull.user, { login: "dependabot[bot]", id: 49699333, type: "Bot" }, { login: "reader-1", id: 6002, type: "User" }]) {
      await host.sync.handle(host.gh.reviewDelivery(host.pull, user, "approved", headSha));
    }
    const store = host.env.ports.store;
    expect([...store.reviews.values()].filter((r) => r.changeId === changeId)).toEqual([]);
    const refused = host.env.ports.audit.events.filter((e) => e.action === "github.review-not-counted");
    expect(refused).toHaveLength(3);
    await host.sync.handle(host.gh.reviewDelivery(host.pull, MAINT, "approved", headSha));
    expect([...store.reviews.values()].filter((r) => r.changeId === changeId)).toEqual([
      expect.objectContaining({ decision: "approve", headSha, source: "github-review" }),
    ]);
    expect((await store.getChange(changeId))?.status).toBe("approved");
    expect([...host.gh.comments.values()][0]?.body).toContain("Approved by maint-1 (GitHub review).");
  });

  it("the check run's buttons: approve_tour approves, full_review is shown, both re-check the sender", async () => {
    const { host, headSha, changeId } = await lane1();
    const run = host.gh.laneRun(headSha)!;
    host.gh.permissions.set("reader-1", "read");
    await host.sync.handle(host.gh.buttonDelivery(run.id, "approve_tour", { login: "reader-1", id: 6002, type: "User" }));
    expect([...host.env.ports.store.reviews.values()].filter((r) => r.changeId === changeId)).toEqual([]);
    await host.sync.handle(host.gh.buttonDelivery(run.id, "full_review", MAINT));
    expect([...host.gh.comments.values()][0]?.body).toContain("Full review requested by maint-1.");
    // A full review asked for: the flagged stops go on the diff for this head.
    expect([...host.gh.reviews.values()].map((r) => r.commit_id)).toEqual([headSha]);
    await host.sync.handle(host.gh.buttonDelivery(run.id, "approve_tour", MAINT));
    expect([...host.env.ports.store.reviews.values()].filter((r) => r.changeId === changeId)).toEqual([
      expect.objectContaining({ decision: "approve", source: "github-check", headSha }),
    ]);
  });

  it("the author may ask for a full review of their own PR (it only adds scrutiny), never approve it", async () => {
    const { host, headSha, changeId } = await lane1();
    const run = host.gh.laneRun(headSha)!;
    const author = host.pull.user;
    host.gh.permissions.set(author.login, "write");
    await host.sync.handle(host.gh.buttonDelivery(run.id, "approve_tour", author));
    expect([...host.env.ports.store.reviews.values()].filter((r) => r.changeId === changeId)).toEqual([]);
    await host.sync.handle(host.gh.buttonDelivery(run.id, "full_review", author));
    expect([...host.gh.comments.values()][0]?.body).toContain(`Full review requested by ${author.login}.`);
    // A bot's press still records nothing.
    const bot = { login: "dependabot[bot]", id: 49699333, type: "Bot" };
    const before = [...host.gh.comments.values()][0]?.body;
    await host.sync.handle(host.gh.buttonDelivery(run.id, "full_review", bot));
    expect([...host.gh.comments.values()][0]?.body).toBe(before);
  });

  it("an approval on gittifacts is the same record (no workflow to wake, nothing merges)", async () => {
    const { host, headSha, changeId } = await lane1();
    const human = host.env.ports.store.addPrincipal({ id: "hu_reviewer", kind: "human", name: "Rae", ownerId: null, keys: [], scopes: ["repo:read", "change:review"] });
    await host.env.coordinator.submitReview(human, changeId, { decision: "approve", headSha });
    expect([...host.env.ports.store.reviews.values()].filter((r) => r.changeId === changeId)).toEqual([
      expect.objectContaining({ decision: "approve", source: "platform", reviewerId: "hu_reviewer" }),
    ]);
    expect((await host.env.ports.store.getChange(changeId))?.status).toBe("approved");
  });
});
