import { describe, expect, it } from "vitest";
import {
  ChangeRef,
  changeRefKey,
  evidenceNoteDegradation,
  HostEvent,
  laneZeroAction,
  NATIVE_CAPABILITIES,
  parseChangeRef,
  routeVerdict,
} from "../src/index.js";

describe("ChangeRef", () => {
  it("round-trips both hosts through its key", () => {
    const refs: ChangeRef[] = [
      { host: "artifacts", repoId: "r1", changeId: "c_123" },
      { host: "github", owner: "acme", repo: "web.app", number: 42 },
    ];
    for (const ref of refs) expect(parseChangeRef(changeRefKey(ref))).toEqual(ref);
    expect(parseChangeRef("acme/web#7")).toEqual({
      host: "github",
      owner: "acme",
      repo: "web",
      number: 7,
    });
    expect(parseChangeRef("nonsense")).toBeNull();
    expect(ChangeRef.safeParse({ host: "gitlab", id: 1 }).success).toBe(false);
  });
});

describe("capability degradations", () => {
  it("Lane 0 merges when the host lets the platform merge", () => {
    expect(laneZeroAction({ canMerge: true })).toEqual({ action: "merge", degradation: null });
  });

  it("Lane 0 becomes label-ready without canMerge, and says so", () => {
    const out = laneZeroAction({ canMerge: false });
    expect(out.action).toBe("label-ready");
    expect(out.degradation).toMatchObject({ capability: "canMerge", instead: "label-ready" });
  });

  it("routes: blocked > auto-merge (lane 0, allowed, no human needed) > review", () => {
    const base = { lane: 0 as const, blocked: false, requiresHumanApproval: false };
    const caps = { canMerge: true };
    expect(routeVerdict({ ...base, autoMergeAllowed: true }, caps).action).toBe("merge");
    expect(routeVerdict({ ...base, autoMergeAllowed: false }, caps).action).toBe("request-review");
    expect(
      routeVerdict({ ...base, autoMergeAllowed: true, requiresHumanApproval: true }, caps).action,
    ).toBe("request-review");
    expect(routeVerdict({ ...base, lane: 1, autoMergeAllowed: true }, caps).action).toBe(
      "request-review",
    );
    expect(routeVerdict({ ...base, blocked: true, autoMergeAllowed: true }, caps).action).toBe(
      "blocked",
    );
    const degraded = routeVerdict({ ...base, autoMergeAllowed: true }, { canMerge: false });
    expect(degraded.action).toBe("label-ready");
    expect(degraded.degradations).toHaveLength(1);
  });

  it("the native host has every capability, so nothing degrades", () => {
    expect(laneZeroAction(NATIVE_CAPABILITIES).degradation).toBeNull();
    expect(evidenceNoteDegradation(NATIVE_CAPABILITIES)).toBeNull();
    expect(evidenceNoteDegradation({ supportsNotes: false })?.instead).toBe("linked");
  });
});

describe("HostEvent", () => {
  it("validates normalized events and rejects unknown types", () => {
    const sha = "a".repeat(40);
    const ok = HostEvent.safeParse({
      type: "change.updated",
      ref: { host: "github", owner: "o", repo: "r", number: 1 },
      headSha: sha,
      previousHeadSha: null,
      forced: true,
    });
    expect(ok.success).toBe(true);
    expect(HostEvent.safeParse({ type: "change.exploded" }).success).toBe(false);
  });
});
