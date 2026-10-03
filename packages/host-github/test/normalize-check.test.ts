import { readFileSync } from "node:fs";
import type { LaneVerdict } from "@app/host";
import { describe, expect, it } from "vitest";
import { claimedCategoryOf } from "../src/adapter.js";
import { githubCapabilities } from "../src/capabilities.js";
import { CHECK_ACTIONS, completedCheckRun, conclusionOf, SUMMARY_MAX } from "../src/check-run.js";
import { classifyAuthor } from "../src/identity.js";
import { mergeGroupPrNumbers, normalizeGithubDelivery } from "../src/normalize.js";

/** Recorded payloads (octokit/webhooks payload-examples), unmodified. */
const payload = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/webhooks/${name}.json`, import.meta.url), "utf8"));

describe("normalize (recorded GitHub payloads)", () => {
  it("pull_request opened / synchronize / closed / reopened", () => {
    const ref = { host: "github", owner: "Codertocat", repo: "Hello-World", number: 2 };
    expect(normalizeGithubDelivery({ event: "pull_request", payload: payload("pull_request_opened") })).toEqual([
      { type: "change.opened", ref, headSha: "ec26c3e57ca3a959ca5aad62de7213c562f8c821", baseSha: "f95f852bd8fca8fcc58a9a2d6c842781e32a215e", author: { kind: "human", id: "21031067", login: "Codertocat" } },
    ]);
    expect(normalizeGithubDelivery({ event: "pull_request", payload: payload("pull_request_synchronize") })).toEqual([
      { type: "change.updated", ref, headSha: "ec26c3e57ca3a959ca5aad62de7213c562f8c821", previousHeadSha: "f95f852bd8fca8fcc58a9a2d6c842781e32a215e", forced: true },
    ]);
    const closed = normalizeGithubDelivery({ event: "pull_request", payload: payload("pull_request_closed") });
    expect(closed).toEqual([expect.objectContaining({ type: "change.closed", ref })]);
    expect(normalizeGithubDelivery({ event: "pull_request", payload: payload("pull_request_reopened") })[0]?.type).toBe("change.opened");
  });

  it("reviews bind to the reviewed commit; pushes only on the default branch; merge groups name their PRs", () => {
    expect(normalizeGithubDelivery({ event: "pull_request_review", payload: payload("pull_request_review_submitted") })).toEqual([
      expect.objectContaining({ type: "review.submitted", headSha: "ec26c3e57ca3a959ca5aad62de7213c562f8c821", decision: "comment" }),
    ]);
    // The recorded push deletes a tag: not a default-branch advance.
    expect(normalizeGithubDelivery({ event: "push", payload: payload("push_payload") })).toEqual([]);
    const main = { ...(payload("push_payload") as object), ref: "refs/heads/master", after: "a".repeat(40) };
    expect(normalizeGithubDelivery({ event: "push", payload: main })).toEqual([
      expect.objectContaining({ type: "main.advanced", branch: "master", after: "a".repeat(40) }),
    ]);
    const mg = normalizeGithubDelivery({ event: "merge_group", payload: payload("merge_group_checks_requested") });
    expect(mg).toEqual([expect.objectContaining({ type: "queue.group_created", headSha: "2ffea6db159f6b6c47a24e778fb9ef40cf6b1c7d", changes: [expect.objectContaining({ number: 104 })] })]);
    expect(mergeGroupPrNumbers("refs/heads/gh-readonly-queue/main/pr-7-abcdef1")).toEqual([7]);
    expect(normalizeGithubDelivery({ event: "installation", payload: payload("installation_created") })).toEqual([]);
    expect(normalizeGithubDelivery({ event: "pull_request", payload: { nonsense: true } })).toEqual([]);
  });

  it("classifies authors: humans, coding agents (accounts or branch conventions), bots", () => {
    expect(classifyAuthor({ login: "octo", type: "User" })).toBe("human");
    expect(classifyAuthor({ login: "copilot-swe-agent[bot]", type: "Bot" })).toBe("agent");
    expect(classifyAuthor({ login: "octo", type: "User", headRef: "claude/fix-allocate" })).toBe("agent");
    expect(classifyAuthor({ login: "dependabot[bot]", type: "Bot" })).toBe("bot");
    expect(classifyAuthor({ login: "my-agent", type: "User" }, { extraAgents: ["my-agent"] })).toBe("agent");
  });

  it("claims come from a gittifacts label or a conventional title", () => {
    expect(claimedCategoryOf({ title: "x", labels: [{ name: "gittifacts:fix" }] })).toBe("fix");
    expect(claimedCategoryOf({ title: "feat(api): add x", labels: [] })).toBe("feature");
    expect(claimedCategoryOf({ title: "Update the README", labels: [{ name: "bug" }] })).toBeNull();
  });
});

const verdict = (over: Partial<LaneVerdict> = {}): LaneVerdict => ({
  lane: 1, computedLane: 0, shadow: true, blocked: false, requiresHumanApproval: true,
  reasons: [{ code: "shadow.lane0-disabled", lane: 1, message: "Lane 0 is in shadow mode." }],
  checklist: [], headSha: "b".repeat(40), action: "request-review", degradations: [],
  tourStatus: "ok", preliminary: false, evidence: { id: "ev1", verified: true }, ...over,
});

describe("gittifacts/lane check run", () => {
  it("success = Lane 0, neutral = Lane 1, action_required = Lane 2 or blocked", () => {
    expect(conclusionOf({ lane: 0, blocked: false })).toBe("success");
    expect(conclusionOf({ lane: 1, blocked: false })).toBe("neutral");
    expect(conclusionOf({ lane: 2, blocked: false })).toBe("action_required");
    expect(conclusionOf({ lane: 0, blocked: true })).toBe("action_required");
  });

  it("says shadow, links the change, stays under 60 KB and GitHub's button limits", () => {
    const ctx = { changeId: "gh-1-2", detailsUrl: "https://x/changes/gh-1-2", shadow: true, evidence: [{ kind: "red-green", status: "proven" }] };
    const run = completedCheckRun(verdict(), ctx, "2026-10-03T12:00:00Z");
    expect(run.output.title).toMatch(/^Shadow · Lane 1/);
    expect(run.details_url).toBe("https://x/changes/gh-1-2");
    expect(run.output.summary).toContain("shadow.lane0-disabled");
    expect(run.actions.map((a) => a.identifier)).toEqual(["approve_tour", "full_review"]);
    for (const a of Object.values(CHECK_ACTIONS)) {
      expect(a.label.length).toBeLessThanOrEqual(20);
      expect(a.description.length).toBeLessThanOrEqual(40);
    }
    const huge = verdict({ reasons: Array.from({ length: 40 }, (_, i) => ({ code: `c${i}`, lane: 2 as const, message: "x".repeat(4000) })) });
    const big = completedCheckRun(huge, { ...ctx, evidence: Array.from({ length: 60 }, () => ({ kind: "k", status: "s", note: "n".repeat(300) })) }, "t");
    expect(big.output.summary.length).toBeLessThanOrEqual(SUMMARY_MAX);
    expect(big.output.summary).toContain("https://x/changes/gh-1-2");
  });

  it("shadow capabilities never merge and degrade Lane 0 to label-ready", () => {
    expect(githubCapabilities()).toMatchObject({ canMerge: false, mergeMode: "none", supportsNotes: false, hasOwnMergeQueue: false });
    expect(githubCapabilities({ actorReady: true, hostQueueRequired: true })).toMatchObject({ canMerge: false, hostQueueRequired: true });
    expect(githubCapabilities({ actorReady: true, hostQueueRequired: false }).mergeMode).toBe("bypass-direct");
  });
});
