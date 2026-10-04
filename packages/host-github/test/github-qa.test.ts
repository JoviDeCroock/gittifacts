/**
 * QA from GitHub on recorded fixtures: the Run QA button and `/gittifacts qa` (the sender re-checked
 * with GitHub each time, humans with write access only), a quiet 👀 instead of a reply, and the
 * result in the existing summary comment and check run (no new comment).
 */

import { withdrawApprovalsForQa } from "@app/coordinator";
import { CONTRACT_SCENARIOS, contractReviewer, loadFixture } from "@app/host-contract";
import { describe, expect, it } from "vitest";
import { changeIdFor } from "../src/ids.js";
import { type QaView, qaSummary } from "../src/qa-section.js";
import type { GithubQaPort } from "../src/sync-qa.js";
import { GithubContractHost } from "./github-host.js";

const MAINT = { login: "maint-1", id: 6001, type: "User" };
const READER = { login: "reader-1", id: 6002, type: "User" };
const BOT = { login: "dependabot[bot]", id: 49699333, type: "Bot" };

function port() {
  const asked: Parameters<GithubQaPort["request"]>[0][] = [];
  const qa: GithubQaPort = {
    request: async (input) => {
      asked.push(input);
      return { runId: `qa-${input.changeId}-1`, reused: asked.length > 1 };
    },
  };
  return { qa, asked };
}

async function lane1(opts: ConstructorParameters<typeof GithubContractHost>[1] = {}) {
  const s = CONTRACT_SCENARIOS["pure-bugfix-with-regression-test"]();
  const fx = loadFixture(s.fixture);
  const host = new GithubContractHost(contractReviewer(), opts);
  const opened = await host.open({ scenario: s, base: fx.base, push: fx.push, title: fx.title });
  await host.settle();
  host.gh.permissions.set(READER.login, "read");
  return { host, ...opened, changeId: changeIdFor(9001, 1) };
}

describe("asking for QA from GitHub", () => {
  it("Run QA: a maintainer or the author asks; a reader, a bot and an older head don't", async () => {
    const { qa, asked } = port();
    const { host, headSha, changeId } = await lane1({ qa });
    const run = host.gh.laneRun(headSha)!;
    expect(JSON.stringify(run.actions)).toContain('"run_qa"');
    for (const who of [READER, BOT])
      await host.sync.handle(host.gh.buttonDelivery(run.id, "run_qa", who));
    expect(asked).toEqual([]);
    expect(
      host.env.ports.audit.events.filter((e) => e.action === "github.qa-refused"),
    ).toHaveLength(2);
    const out = await host.sync.handle(host.gh.buttonDelivery(run.id, "run_qa", MAINT));
    expect(out[0]).toMatchObject({ action: "recorded", changeId });
    expect(asked).toEqual([
      expect.objectContaining({ changeId, login: "maint-1", via: "github-check" }),
    ]);
    await host.sync.handle(host.gh.buttonDelivery(run.id, "run_qa", host.pull.user));
    expect(asked.at(-1)).toMatchObject({ login: host.pull.user.login });
    // No comment was written for any of it.
    expect(host.gh.comments.size).toBe(1);
  });

  it("/gittifacts qa: 👀 for a writer, 😕 for a refusal, never a reply; non-commands are ignored", async () => {
    const { qa, asked } = port();
    const { host, changeId } = await lane1({ qa });
    const writes = host.gh.writes.length;
    await host.sync.handle(host.gh.commentDelivery(host.pull, READER, "/gittifacts qa"));
    await host.sync.handle(
      host.gh.commentDelivery(host.pull, MAINT, "looks good, can we /gittifacts qa later?"),
    );
    await host.sync.handle(
      host.gh.commentDelivery(host.pull, MAINT, "/gittifacts qa", { onIssue: true }),
    );
    expect(asked).toEqual([]);
    const out = await host.sync.handle(
      host.gh.commentDelivery(host.pull, MAINT, "  /gittifacts qa\nplease check the signup flow"),
    );
    expect(out[0]).toMatchObject({ action: "recorded", changeId });
    expect(asked).toEqual([expect.objectContaining({ via: "github-comment", login: "maint-1" })]);
    // The reader's refused command gets 😕, the writer's 👀; nothing else is written.
    expect(host.gh.reactions.map((r) => r.content)).toEqual(["confused", "eyes"]);
    expect(host.gh.writes.slice(writes)).toEqual(["POST reaction", "POST reaction"]);
  });
});

describe("the result, quietly", () => {
  it("goes into the existing summary comment (headline line + fold with thumbnails) and the check run text", async () => {
    let view: QaView | null = null;
    const { host, ref, headSha } = await lane1({
      qaView: async () => (view === null ? null : qaSummary(view)),
    });
    view = {
      runId: "qa-1",
      headSha,
      status: "done",
      passed: 1,
      failed: 1,
      couldntTest: 0,
      criteria: [
        { text: "The counter goes up by one", verdict: "pass", reason: "1 expectation held" },
        {
          text: "The greeting uses the name",
          verdict: "fail",
          reason: 'expect_text "Hello Ada": not found',
        },
      ],
      thumbs: [
        {
          url: "https://gittifacts.test/qa-img/qa-1/c0-thumb.jpg?exp=1&sig=s",
          alt: "The counter goes up by one",
        },
      ],
      reportUrl: "https://gittifacts.test/changes/gh-9001-1#qa",
      error: null,
      requestedBy: "@maint-1",
    };
    await host.adapter.publishSummary(ref);
    const comments = [...host.gh.comments.values()];
    expect(comments).toHaveLength(1);
    const body = comments[0]?.body ?? "";
    expect(body).toContain(
      "**QA** · 1 passed, 1 failed of 2 criteria · [QA report](https://gittifacts.test/changes/gh-9001-1#qa)",
    );
    expect(body).toMatch(
      /<details><summary>QA details<\/summary>[\s\S]*\*\*Fail\*\* · The greeting uses the name \(expect_text/,
    );
    expect(body).toContain(
      '<a href="https://gittifacts.test/changes/gh-9001-1#qa"><img src="https://gittifacts.test/qa-img/qa-1/c0-thumb.jpg?exp=1&sig=s" width="200"',
    );
    // Who asked is named, never @-mentioned (an edit that adds a mention notifies).
    expect(body).toContain("Requested by @\u200bmaint-1.");
    const cls = (await host.env.ports.store.getClassification("gh-9001-1", headSha))!;
    await host.adapter.publishVerdict(ref, {
      ...cls,
      headSha,
      action: "request-review",
      degradations: [],
      tourStatus: "ok",
      preliminary: false,
      evidence: null,
    });
    expect(host.gh.laneRun(headSha)?.output.text).toMatch(
      /^\*\*QA\*\* · 1 passed, 1 failed of 2 criteria[\s\S]*<details><summary>QA details<\/summary>/,
    );
    expect(host.gh.comments.size).toBe(1);
  });
});

describe("a QA failure after approval (GitHub)", () => {
  it("withdraws the approval: the summary comment is edited in place (no approval, the QA line says whose was withdrawn)", async () => {
    let view: QaView | null = null;
    const { host, ref, headSha, changeId } = await lane1({
      qaView: async () => (view === null ? null : qaSummary(view)),
    });
    await host.sync.handle(host.gh.reviewDelivery(host.pull, MAINT, "approved", headSha));
    const store = host.env.ports.store;
    expect((await store.getChange(changeId))?.status).toBe("approved");
    const before = [...host.gh.comments.values()];
    expect(before).toHaveLength(1);
    expect(before[0]?.body).toContain("maint-1 (GitHub review)");
    const editsBefore = before[0]?.edits ?? 0;

    const out = await withdrawApprovalsForQa(host.env.ports, host.env.bindings, {
      changeId,
      headSha,
      runId: "qa-1",
      failed: ["The greeting uses the name"],
    });
    expect(out.withdrawn).toHaveLength(1);
    expect((await store.getChange(changeId))?.status).toBe("awaiting-review");
    expect(
      [...store.reviews.values()].find((r) => r.changeId === changeId)?.withdrawn,
    ).toMatchObject({ reason: "qa-failed", by: "qa-1" });
    expect(host.env.ports.audit.events.map((e) => e.action)).toContain("approval.withdrawn");

    view = {
      runId: "qa-1",
      headSha,
      status: "done",
      passed: 0,
      failed: 1,
      couldntTest: 0,
      criteria: [
        {
          text: "The greeting uses the name",
          verdict: "fail",
          reason: 'expect_text "Hello Ada": not found',
        },
      ],
      thumbs: [],
      reportUrl: "https://gittifacts.test/changes/gh-9001-1#qa",
      error: null,
      requestedBy: "@maint-1",
      withdrawn: ["maint-1"],
    };
    await host.adapter.publishSummary(ref);
    const after = [...host.gh.comments.values()];
    expect(after).toHaveLength(1);
    expect(after[0]?.edits).toBe(editsBefore + 1);
    expect(after[0]?.body).toContain(
      "**QA** · 0 passed, 1 failed of 1 criterion · approval by maint-1 withdrawn: QA failed",
    );
    expect(after[0]?.body).toContain("**Approved by**: nobody yet");
    // "Couldn't test" never withdraws: a second call finds nothing left to withdraw anyway.
    expect(
      (
        await withdrawApprovalsForQa(host.env.ports, host.env.bindings, {
          changeId,
          headSha,
          runId: "qa-2",
          failed: ["x"],
        })
      ).withdrawn,
    ).toEqual([]);
  });
});
