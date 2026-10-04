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

async function lane1() {
  const s = CONTRACT_SCENARIOS["pure-bugfix-with-regression-test"]();
  const fx = loadFixture(s.fixture);
  const host = new GithubContractHost(contractReviewer());
  const opened = await host.open({ scenario: s, base: fx.base, push: fx.push, title: fx.title });
  await host.settle();
  return { host, s, fx, ...opened, changeId: changeIdFor(9001, 1) };
}

describe("the tour as one PR review per head", () => {
  it("posts one COMMENT review with inline stops (≤ 20) and one summary comment", async () => {
    const { host, headSha } = await lane1();
    const reviews = [...host.gh.reviews.values()];
    expect(reviews).toHaveLength(1);
    const r = reviews[0]!;
    expect(r).toMatchObject({ commit_id: headSha, event: "COMMENT", minimized: false });
    expect(r.comments.length).toBeGreaterThan(0);
    expect(r.comments.length).toBeLessThanOrEqual(20);
    expect(r.body).toContain("Least confident");
    expect(r.body).toContain("never approves");
    const comments = [...host.gh.comments.values()];
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toMatch(/Lane 1/);
    expect(comments[0]?.body).toContain("in the review below");
  });

  it("a new head stales and minimizes the old review, posts a new one, and edits the summary in place", async () => {
    const { host, ref, headSha: first, fx } = await lane1();
    const path = "test/allocate.test.ts";
    const second = await host.push(ref, { [path]: `${fx.head[path] ?? ""}// again\n` }, { force: false });
    await host.settle();
    const [old, fresh] = [...host.gh.reviews.values()];
    expect(old).toMatchObject({ commit_id: first, minimized: true });
    expect(old?.body).toContain("stale");
    expect(old?.comments.every((c) => c.body.startsWith("**Stale.**"))).toBe(true);
    expect(fresh).toMatchObject({ commit_id: second, minimized: false });
    const summary = [...host.gh.comments.values()];
    expect(summary).toHaveLength(1);
    expect(summary[0]?.body).toContain(second.slice(0, 7));
    // A redelivered head changes nothing: no new review, no summary edit.
    const edits = summary[0]?.edits ?? 0;
    const writes = host.gh.writes.length;
    await host.sync.handle(host.gh.pullRequestDelivery("synchronize", host.pull, first));
    await host.settle();
    expect(host.gh.reviews.size).toBe(2);
    expect(summary[0]?.edits).toBe(edits);
    expect(host.gh.writes.slice(writes).filter((w) => !w.includes("check-runs"))).toEqual([]);
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
    expect([...host.gh.comments.values()][0]?.body).toContain("@maint-1 (GitHub review)");
  });

  it("the check run's buttons: approve_tour approves, full_review is shown, both re-check the sender", async () => {
    const { host, headSha, changeId } = await lane1();
    const run = host.gh.laneRun(headSha)!;
    host.gh.permissions.set("reader-1", "read");
    await host.sync.handle(host.gh.buttonDelivery(run.id, "approve_tour", { login: "reader-1", id: 6002, type: "User" }));
    expect([...host.env.ports.store.reviews.values()].filter((r) => r.changeId === changeId)).toEqual([]);
    await host.sync.handle(host.gh.buttonDelivery(run.id, "full_review", MAINT));
    expect([...host.gh.comments.values()][0]?.body).toContain("Full review requested by | @maint-1");
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
    expect([...host.gh.comments.values()][0]?.body).toContain(`Full review requested by | @${author.login}`);
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
