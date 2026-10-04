import { readFileSync } from "node:fs";
import type { LaneVerdict } from "@app/host";
import { describe, expect, it } from "vitest";
import { claimedCategoryOf } from "../src/adapter.js";
import { githubCapabilities } from "../src/capabilities.js";
import { CHECK_ACTIONS, checkTitle, completedCheckRun, conclusionOf, laneRun, readCheckRunVerdict, SUMMARY_MAX } from "../src/check-run.js";
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
    expect(conclusionOf({ lane: 0, blocked: false, action: "label-ready" })).toBe("success");
    expect(conclusionOf({ lane: 0, blocked: false, action: "request-review" })).toBe("neutral");
    expect(conclusionOf({ lane: 1, blocked: false, action: "request-review" })).toBe("neutral");
    expect(conclusionOf({ lane: 2, blocked: false, action: "request-review" })).toBe("action_required");
    expect(conclusionOf({ lane: 0, blocked: true, action: "blocked" })).toBe("action_required");
    // Report-only: never a red ✕ (or a green ✓ for something nobody enforces); the title says the lane.
    for (const v of [{ lane: 0 as const, blocked: false, action: "label-ready" as const }, { lane: 2 as const, blocked: false, action: "request-review" as const }, { lane: 2 as const, blocked: true, action: "blocked" as const }]) {
      expect(conclusionOf(v, { reportOnly: true })).toBe("neutral");
    }
  });

  it("a short title (≤ 60), a few summary lines, detail folded in text; GitHub's button limits", () => {
    const ctx = { changeId: "gh-1-2", detailsUrl: "https://x/changes/gh-1-2", shadow: true, evidence: [{ kind: "red-green", status: "proven" }] };
    const run = completedCheckRun(verdict(), ctx, "2026-10-03T12:00:00Z");
    expect(run.output.title).toBe("Quick review (Lane 1) · auto-merge is calibrating");
    expect(run.details_url).toBe("https://x/changes/gh-1-2");
    expect(run.output.summary.split("\n").filter((l) => l !== "").length).toBeLessThanOrEqual(4);
    expect(run.output.summary).toContain("Report-only");
    // GitHub shows the title right above the summary: it isn't repeated, only lengthened.
    expect(run.output.summary).not.toContain("Quick review (Lane 1)");
    expect(run.output.summary.split("\n")[0]).toBe("The evidence says auto-merge, but auto-merge is still calibrating on this repo.");
    expect(run.output.summary).not.toMatch(/^\|/m);
    expect(run.output.text).toMatch(/^<details><summary>Why this lane: 1 raised, 0 passed<\/summary>/);
    expect(run.output.text).toContain("<details><summary>Evidence: 1 item, signed and verified</summary>");
    expect(run.actions.map((a) => a.identifier)).toEqual(["approve_tour", "full_review"]);
    expect(run.actions.map((a) => a.label)).toEqual(["Approve change", "Request full review"]);
    for (const a of Object.values(CHECK_ACTIONS)) {
      expect(a.label.length).toBeLessThanOrEqual(20);
      expect(a.description.length).toBeLessThanOrEqual(40);
    }
    const huge = verdict({ reasons: Array.from({ length: 40 }, (_, i) => ({ code: `c${i}`, lane: 2 as const, message: "x".repeat(4000) })) });
    const big = completedCheckRun(huge, { ...ctx, evidence: Array.from({ length: 60 }, () => ({ kind: "k", status: "s", note: "n".repeat(300) })) }, "t");
    expect(big.output.summary.length).toBeLessThanOrEqual(SUMMARY_MAX);
    expect(big.output.text.length).toBeLessThanOrEqual(SUMMARY_MAX);
    expect(big.output.summary).toContain("https://x/changes/gh-1-2");
  });

  it("titles name the lane and the one reason that decided it", () => {
    const t = (over: Partial<LaneVerdict>) => checkTitle(verdict(over));
    expect(t({ lane: 2, computedLane: 2, shadow: false, reasons: [{ code: "api.additive", lane: 2, message: "m" }, { code: "plan.missing", lane: 1, message: "m" }] }))
      .toBe("Full review (Lane 2) · public API changed");
    expect(t({ lane: 2, computedLane: 2, shadow: false, reasons: [{ code: "llm.concern", lane: 2, message: "Model judgment on hidden-behavior-change raised a concern: x" }] }))
      .toBe("Full review (Lane 2) · possible hidden behavior change");
    // Unknown escalates, and the title says what was not measured.
    expect(t({ lane: 1, computedLane: 1, shadow: false, reasons: [{ code: "signal.missing.coverage", lane: 1, message: "m" }] }))
      .toBe("Quick review (Lane 1) · coverage did not run");
    expect(t({ lane: 0, computedLane: 0, shadow: false, reasons: [{ code: "ci.passed", lane: 0, message: "m" }] })).toBe("Auto-merge (Lane 0) · all checks passed");
    expect(t({ lane: 2, computedLane: 2, blocked: true, reasons: [{ code: "ci.failed", lane: 2, message: "m" }] })).toBe("Blocked: CI failed");
    expect(t({ lane: 2, computedLane: 2, shadow: false, reasons: [{ code: "x".repeat(90), lane: 2, message: "m" }] }).length).toBeLessThanOrEqual(60);
  });

  it("the early lane stays in progress, says 'so far' below Lane 2, and is never Lane 0 or blocked", () => {
    const ctx = { detailsUrl: "https://x/changes/gh-1-2", shadow: true };
    expect(laneRun(verdict(), ctx)).toMatchObject({ status: "in_progress", output: { title: "Quick review (Lane 1) so far · walkthrough coming" } });
    expect(laneRun(verdict(), ctx)).not.toHaveProperty("conclusion");
    expect(laneRun(verdict({ lane: 2, computedLane: 2, shadow: false }), ctx)?.output.title).toBe("Full review (Lane 2) · walkthrough coming");
    expect(laneRun(verdict({ lane: 0, computedLane: 0, shadow: false }), ctx)).toBeNull();
    expect(laneRun(verdict({ lane: 2, blocked: true }), ctx)).toBeNull();
  });

  it("shadow capabilities never merge and degrade Lane 0 to label-ready", () => {
    expect(githubCapabilities()).toMatchObject({ canMerge: false, mergeMode: "none", supportsNotes: false, hasOwnMergeQueue: false });
    expect(githubCapabilities({ actorReady: true, hostQueueRequired: true })).toMatchObject({ canMerge: false, hostQueueRequired: true });
    expect(githubCapabilities({ actorReady: true, hostQueueRequired: false }).mergeMode).toBe("bypass-direct");
  });
});

describe("reading a completed gittifacts/lane run back (live contract run)", () => {
  const ctx = {
    changeId: "gh-1-2", detailsUrl: "https://x/changes/gh-1-2", shadow: true,
    evidence: [{ kind: "red-green", status: "proven" }, { kind: "api-diff", status: "none", note: "a | b" }, { kind: "red-green", status: "proven" }],
  };
  const read = (v: LaneVerdict, c = ctx) => readCheckRunVerdict(completedCheckRun(v, c, "t").output);

  it("round-trips the verdict, the reason codes and the evidence kinds", () => {
    const v = verdict({
      reasons: [
        { code: "shadow.lane0-disabled", lane: 1, message: "Lane 0 is in shadow mode." },
        { code: "plan.missing", lane: 2, message: "No approved | plan" },
      ],
    });
    expect(read(v)).toEqual({
      verdict: { lane: 1, computedLane: 0, shadow: true, blocked: false, requiresHumanApproval: true, reasons: [{ code: "shadow.lane0-disabled" }, { code: "plan.missing" }] },
      kinds: ["api-diff", "red-green"],
    });
  });

  it("reads blocked, an unraised lane, no approval and the verdict's own shadow (not the platform's mode)", () => {
    const v = verdict({ lane: 2, computedLane: 2, shadow: false, blocked: true, requiresHumanApproval: false, reasons: [], action: "blocked" });
    expect(read(v, { ...ctx, evidence: [] })).toEqual({
      verdict: { lane: 2, computedLane: 2, shadow: false, blocked: true, requiresHumanApproval: false, reasons: [] },
      kinds: [],
    });
  });

  // Runs written before 2026-10-04 keep their text on GitHub forever.
  const legacy = {
    title: "Shadow · Lane 1: a quick look with a guided tour",
    summary: [
      "**Shadow mode.** gittifacts graded this head.", "", "| | |", "|---|---|", "| Lane | **1** |",
      "| Computed lane | 0 (raised by policy) |", "| Head | `bbbb` |", "| Human approval | required |", "", "### Why", "",
      "- `shadow.lane0-disabled` (lane 1): Lane 0 is in shadow mode.", "- `ci.passed` (lane 0): CI passed.", "", "### Evidence", "",
      "| Kind | Status | Note |", "|---|---|---|", "| red-green | ok |  |", "| coverage | ok | x |", "", "[The tour](https://x)",
    ].join("\n"),
  };

  it("reads the old format: the 'Shadow · ' title, the | Lane | **N** | row, Why and Evidence", () => {
    expect(readCheckRunVerdict(legacy)).toEqual({
      verdict: { lane: 1, computedLane: 0, shadow: true, blocked: false, requiresHumanApproval: true, reasons: [{ code: "shadow.lane0-disabled" }, { code: "ci.passed" }] },
      kinds: ["coverage", "red-green"],
    });
    // Same table with a "Report-only · " title (the renamed prefix) and with text: null.
    expect(readCheckRunVerdict({ ...legacy, title: "Report-only · Quick review (Lane 1)", text: null }).verdict?.shadow).toBe(true);
    expect(readCheckRunVerdict({ ...legacy, title: "Blocked: CI failed or the evidence did not verify" }).verdict).toMatchObject({ shadow: false, blocked: true });
  });

  it("a malformed hidden verdict is no verdict (never a guessed lane)", () => {
    expect(readCheckRunVerdict({ title: "t", summary: "s", text: '<!-- gittifacts:verdict {"lane":7} -->' }).verdict).toBeUndefined();
    expect(readCheckRunVerdict({ title: "t", summary: "s", text: "<!-- gittifacts:verdict {nope} -->" }).verdict).toBeUndefined();
  });

  it("an in-progress run has no verdict", () => {
    expect(readCheckRunVerdict({ title: "Shadow · grading", summary: "gittifacts is running the evidence" }).verdict).toBeUndefined();
    const early = laneRun(verdict(), { detailsUrl: "https://x", shadow: true });
    expect(readCheckRunVerdict({ ...early!.output, text: null }).verdict).toBeUndefined();
  });
});
