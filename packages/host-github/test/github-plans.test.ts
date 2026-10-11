/**
 * Plans on GitHub (spec §3.5) and re-grading: a closing issue labelled `gittifacts:plan` by a
 * writer who is neither author is an approved Plan; anyone else's label leaves a draft; a plan
 * file on the default branch is imported as a draft; label/title edits and later plan labels
 * grade the head again (a fresh check run).
 */
import { CONTRACT_SCENARIOS, contractReviewer, loadFixture } from "@app/host-contract";
import { describe, expect, it } from "vitest";
import { changeIdFor } from "../src/ids.js";
import type { FakeIssue } from "./fake-github.js";
import { GithubContractHost } from "./github-host.js";

const ISSUE_BODY = [
  "allocate() drops a minor unit on uneven splits.",
  "",
  "## Acceptance criteria",
  "- Shares add up to the total",
  "- A regression test fails before the fix",
  "",
  "## Scope",
  "- src/allocate.ts",
  "- test/allocate.test.ts",
].join("\n");

function issue(labeler: { login: string; id: number; type: string } | null): FakeIssue {
  return {
    number: 12,
    title: "Fix allocate() losing a minor unit",
    body: ISSUE_BODY,
    user: { login: "issue-writer", id: 7001, type: "User" },
    labels: labeler === null ? [] : ["gittifacts:plan"],
    events:
      labeler === null
        ? []
        : [
            {
              event: "labeled",
              label: { name: "gittifacts:plan" },
              actor: labeler,
              created_at: "2026-10-03T08:00:00Z",
            },
          ],
  };
}

async function open(setup: (h: GithubContractHost) => void) {
  const s = { ...CONTRACT_SCENARIOS["pure-bugfix-with-regression-test"](), plan: null };
  const fx = loadFixture(s.fixture);
  const host = new GithubContractHost(contractReviewer());
  setup(host);
  const opened = await host.open({ scenario: s, base: fx.base, push: fx.push, title: fx.title });
  await host.settle();
  const changeId = changeIdFor(9001, 1);
  const reasons = async () =>
    (await host.env.ports.store.getClassification(changeId, opened.headSha))?.reasons.map(
      (r) => r.code,
    ) ?? [];
  return { host, changeId, reasons, ...opened };
}

describe("plans from GitHub", () => {
  it("a closing issue labelled by a maintainer is an approved Plan", async () => {
    const { host, changeId, reasons } = await open((h) => {
      h.gh.issues.set(12, issue({ login: "maint-1", id: 6001, type: "User" }));
      h.prBody = "Fixes the split.\n\nCloses #12";
    });
    const change = await host.env.ports.store.getChange(changeId);
    expect(change).toMatchObject({ planId: "ghi-9001-12", host: { issueRefs: [12] } });
    expect(await host.env.ports.store.getPlan("ghi-9001-12")).toMatchObject({
      status: "approved",
      approvedBy: "gh-u-6001",
      authorId: "gh-u-7001",
      scopePaths: ["src/allocate.ts", "test/allocate.test.ts"],
    });
    expect(await reasons()).toContain("plan.approved");
  });

  it("the PR's author labelling the issue is no approval: a draft Plan, graded not approved", async () => {
    const { host, reasons } = await open((h) => {
      h.gh.issues.set(12, issue({ login: "octo-author", id: 4711, type: "User" }));
      h.prBody = "Closes #12";
    });
    expect(await host.env.ports.store.getPlan("ghi-9001-12")).toMatchObject({
      status: "draft",
      approvedBy: null,
    });
    expect(await reasons()).toContain("plan.not-approved");
  });

  it("a plan file on the default branch is imported as a draft a human approves on gittifacts", async () => {
    const { host, changeId, reasons } = await open((h) => {
      h.baseExtra = { ".platform/plans/fix-allocate.md": `# Fix allocate()\n\n${ISSUE_BODY}\n` };
      h.prBody = "gittifacts-plan: fix-allocate";
    });
    expect((await host.env.ports.store.getChange(changeId))?.planId).toBe("ghp-9001-fix-allocate");
    expect(await host.env.ports.store.getPlan("ghp-9001-fix-allocate")).toMatchObject({
      status: "draft",
      title: "Fix allocate()",
    });
    expect(await reasons()).toContain("plan.not-approved");
  });
});

describe("re-grading the same head", () => {
  it("adding a claim label grades again, with a fresh check run", async () => {
    const { host, changeId, headSha, ref } = await open((h) => {
      h.prLabels = [];
    });
    expect((await host.env.ports.store.getChange(changeId))?.claim.category).toBe("feature");
    // The walkthrough label too, so the head's review is posted (then staled by the re-grade).
    host.pull.labels = ["gittifacts:fix", "gittifacts:walkthrough"];
    await host.sync.handle(host.gh.editDelivery(host.pull, "labeled"));
    await host.settle();
    expect((await host.env.ports.store.getChange(changeId))?.claim.category).toBe("fix");
    expect([...host.gh.checkRuns.values()].filter((r) => r.head_sha === headSha)).toHaveLength(2);
    expect(
      (await host.verdictHeads(ref)).filter((h) => h === headSha).length,
    ).toBeGreaterThanOrEqual(2);
    // The same head's earlier tour review was staled; the new grading posted a fresh one.
    const reviews = [...host.gh.reviews.values()].filter((r) => r.commit_id === headSha);
    expect(reviews.map((r) => r.minimized)).toEqual([true, false]);
  });

  it("a plan label added later links the Plan and grades again", async () => {
    const { host, changeId, reasons } = await open((h) => {
      h.gh.issues.set(12, issue(null));
      h.prBody = "Closes #12";
    });
    expect((await host.env.ports.store.getChange(changeId))?.planId).toBeNull();
    host.gh.issues.set(12, issue({ login: "maint-1", id: 6001, type: "User" }));
    await host.sync.handle(host.gh.issueLabelDelivery(host.gh.issues.get(12)!, "gittifacts:plan"));
    await host.settle();
    expect((await host.env.ports.store.getChange(changeId))?.planId).toBe("ghi-9001-12");
    expect(await reasons()).toContain("plan.approved");
  });
});
