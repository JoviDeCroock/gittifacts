/**
 * Merge-queue rules: conflict resolutions and quarantined tests may only raise the lane, and
 * neverLower keeps a resolved Change's lane at least where it was before the resolution.
 */
import { describe, expect, it } from "vitest";
import {
  type ClassifyResult,
  GATES,
  neverLower,
  REASON_CODES,
  type ReasonCode,
  reclassifyAfterResolution,
} from "../src/index.js";
import {
  addFiles,
  type ClassifyInput,
  file,
  gateOf,
  green,
  llm,
  mutate,
  publicApi,
  quarantine,
  raisedCodes,
  reasonFor,
  replaceKind,
  resolution,
  run,
  sensitivePaths,
  setStatus,
  withItems,
  withoutKind,
} from "./helpers.js";
import { codemodRename, pureBugfixWithRegressionTest } from "./scenarios.js";

// ---------------------------------------------------------------- classify

describe("conflict-resolution evidence", () => {
  it("a resolution inside the conflict hunks is informational: the lane stays Lane 0", () => {
    const r = run(withItems(green(), resolution()));
    expect(r.computedLane).toBe(0);
    expect(r.lane).toBe(0);
    expect(reasonFor(r, "resolution.within-conflict")).toMatchObject({
      lane: 0,
      evidenceRef: "conflict-resolution",
    });
    expect(reasonFor(r, "resolution.within-conflict")?.message).toContain("chg_upstream");
    expect(gateOf(r, "conflict-resolution").passed).toBe(true);
  });

  it("edits outside the conflict hunks raise to Lane 1", () => {
    const r = run(withItems(green(), resolution({ touchesOutsideConflictHunks: true })));
    expect(r.computedLane).toBe(1);
    expect(raisedCodes(r)).toEqual(["resolution.outside-conflict"]);
    expect(gateOf(r, "conflict-resolution").passed).toBe(false);
    expect(reasonFor(r, "resolution.within-conflict")).toBeUndefined();
  });

  it("edits with no conflict hunk are read as outside even if the item says otherwise", () => {
    const r = run(withItems(green(), resolution({ conflictHunks: [] })));
    expect(raisedCodes(r)).toEqual(["resolution.outside-conflict"]);
  });

  it("a semantic-conflict resolution is at least Lane 1 and names the culprit", () => {
    const r = run(
      withItems(
        green(),
        resolution({
          conflictHunks: [],
          touchesOutsideConflictHunks: true,
          semanticConflictWith: "chg_upstream",
          rationale: "Upstream renamed `slug` to `handle`.",
        }),
      ),
    );
    expect(r.computedLane).toBe(1);
    expect(raisedCodes(r)).toEqual(["resolution.outside-conflict", "resolution.semantic"]);
    expect(reasonFor(r, "resolution.semantic")?.message).toBe(
      "Resolved a semantic conflict caused by upstream change chg_upstream: Upstream renamed `slug` to `handle`.",
    );
  });

  it("a truncated or skipped record is unknown (Lane 1)", () => {
    const t = run(withItems(green(), resolution({ truncated: true })));
    expect(raisedCodes(t)).toEqual(["resolution.truncated"]);
    expect(gateOf(t, "conflict-resolution").passed).toBeNull();
    const s = run(withItems(green(), resolution({ status: "skipped", note: "not needed" })));
    expect(raisedCodes(s)).toEqual(["resolution.skipped"]);
    expect(reasonFor(s, "resolution.skipped")?.message).toContain("not needed");
  });

  it("a failed resolution is Lane 2", () => {
    const r = run(
      withItems(green(), resolution({ status: "error", note: "output invalid twice" })),
    );
    expect(r.computedLane).toBe(2);
    expect(raisedCodes(r)).toEqual(["signal.error.conflict-resolution"]);
    expect(reasonFor(r, "signal.error.conflict-resolution")?.message).toBe(
      "Conflict resolution failed: output invalid twice.",
    );
  });

  it("every resolution reason is on the conflict-resolution gate, which exists for every change", () => {
    expect(GATES).toContain("conflict-resolution");
    for (const [code, spec] of Object.entries(REASON_CODES)) {
      if (code.startsWith("resolution.") || code === "signal.error.conflict-resolution")
        expect(spec.gates, code).toEqual(["conflict-resolution"]);
    }
    expect(gateOf(run(green()), "conflict-resolution")).toEqual({
      gate: "conflict-resolution",
      passed: true,
      detail: "No issues.",
    });
  });
});

describe("quarantine evidence", () => {
  it("a quarantined test in the affected set never counts as passing: Lane 1, tests unknown", () => {
    const r = run(withItems(green(), quarantine()));
    expect(r.computedLane).toBe(1);
    expect(raisedCodes(r)).toEqual(["tests.quarantined"]);
    expect(gateOf(r, "tests").passed).toBeNull();
    expect(reasonFor(r, "tests.quarantined")?.message).toBe(
      "1 quarantined test(s) in this change's affected set did not count as passing: test/slugify.test.ts > flaky clock.",
    );
  });

  it("quarantined tests outside the affected set are listed but do not raise", () => {
    const r = run(withItems(green(), quarantine({ inAffectedSet: [] })));
    expect(r.computedLane).toBe(0);
    expect(reasonFor(r, "tests.quarantined-unaffected")?.lane).toBe(0);
    expect(gateOf(r, "tests").detail).toContain("none in this change's affected set");
  });

  it("an unreadable quarantine list is Lane 1; an empty or skipped one changes nothing", () => {
    expect(raisedCodes(run(withItems(green(), quarantine({ status: "error" }))))).toEqual([
      "signal.error.quarantine",
    ]);
    const empty = run(withItems(green(), quarantine({ tests: [], inAffectedSet: [] })));
    expect(empty).toStrictEqual(run(green()));
    expect(run(withItems(green(), quarantine({ status: "skipped" }))).computedLane).toBe(0);
  });
});

// ---------------------------------------------------------------- neverLower

/** The merged tree no longer shows the breaking export (upstream made the same change). */
function breakingBefore(): ClassifyInput {
  return replaceKind(green(), "public-api", publicApi("breaking"));
}

describe("neverLower", () => {
  it("returns next unchanged when there is no previous classification", () => {
    const next = run(green());
    expect(neverLower(null, next)).toBe(next);
  });

  it("returns next when it is not lower", () => {
    const prev = run(green());
    const next = run(withItems(green(), resolution({ touchesOutsideConflictHunks: true })));
    expect(neverLower(prev, next)).toBe(next);
  });

  it("keeps the previous lane with a resolution.lane-kept reason when the merged tree is lower", () => {
    const prev = run(breakingBefore());
    const next = run(withItems(green(), resolution()));
    expect([prev.lane, next.lane]).toEqual([2, 0]);
    const r = neverLower(prev, next);
    expect(r.lane).toBe(2);
    expect(r.computedLane).toBe(2);
    expect(r.shadow).toBe(false);
    const kept = reasonFor(r, "resolution.lane-kept");
    expect(kept).toEqual({
      code: "resolution.lane-kept",
      lane: 2,
      message:
        "Lane kept at 2: the merged tree classified lower (Lane 0), but a conflict resolution can only keep or raise the lane (before: api.breaking).",
    });
    expect(r.reasons[0]?.code).toBe("resolution.lane-kept");
    expect(gateOf(r, "conflict-resolution")).toMatchObject({ passed: false });
    // Every reason of the merged tree is still there.
    for (const reason of next.reasons) expect(r.reasons).toContainEqual(reason);
  });

  it("drops shadow mode when it raises a shadowed Lane 0 back to Lane 1", () => {
    const shadowed = (i: ClassifyInput) => mutate(i, (d) => (d.policy.lane0Enabled = false));
    const prev = run(shadowed(replaceKind(green(), "public-api", publicApi("additive"))));
    const next = run(shadowed(withItems(green(), resolution())));
    expect([prev.computedLane, next.computedLane, next.lane, next.shadow]).toEqual([1, 0, 1, true]);
    const r = neverLower(prev, next);
    expect([r.computedLane, r.lane, r.shadow]).toEqual([1, 1, false]);
    expect(r.reasons.map((x) => x.code)).not.toContain("shadow.lane0-disabled");
    expect(reasonFor(r, "resolution.lane-kept")?.lane).toBe(1);
  });

  it("keeps a human-approval requirement", () => {
    const prev = run(addFiles(green(), file(".platform/ci.ts", 1, 0)));
    expect(prev.requiresHumanApproval).toBe(true);
    const r = neverLower(prev, run(withItems(green(), resolution())));
    expect(r.requiresHumanApproval).toBe(true);
    expect(r.lane).toBe(2);
  });

  it("reclassifyAfterResolution is classify floored at the previous result", () => {
    const prev = run(breakingBefore());
    const input = withItems(green(), resolution());
    const r = reclassifyAfterResolution(
      prev,
      input.evidence,
      input.policy,
      input.plan,
      input.diffStats,
      input.change,
      input.context,
    );
    expect(r).toStrictEqual(neverLower(prev, run(input)));
  });
});

// ---------------------------------------------------------------- properties

const INPUTS: ReadonlyArray<readonly [string, () => ClassifyInput]> = [
  ["green", green],
  ["green, shadow", () => mutate(green(), (d) => (d.policy.lane0Enabled = false))],
  ["additive", () => replaceKind(green(), "public-api", publicApi("additive"))],
  ["breaking", breakingBefore],
  ["sensitive", () => addFiles(green(), file("src/auth/x.ts", 1, 0))],
  ["policy file", () => addFiles(green(), file(".platform/ci.ts", 1, 0))],
  ["no tests", () => withoutKind(green(), "test-run")],
  ["coverage errored", () => setStatus(green(), "coverage", "error")],
  ["llm concern", () => withItems(green(), llm("concern"))],
  ["evidence unverified", () => mutate(green(), (d) => (d.context.evidenceVerified = false))],
  [
    "sensitive evidence hit",
    () =>
      replaceKind(
        green(),
        "sensitive-paths",
        sensitivePaths([{ path: "src/x", pattern: "src/**" }]),
      ),
  ],
  ["codemod", () => codemodRename({ lane0Enabled: true, extraFiles: 3 }).input],
  ["bugfix (shadow)", () => pureBugfixWithRegressionTest().input],
  [
    "verified revert",
    () =>
      mutate(withoutKind(green(), "red-green"), (d) => {
        d.plan = null;
        d.change.category = "revert";
        d.policy.lane0Enabled = false;
        d.context.pureRevertVerified = true;
      }),
  ],
];

const RESOLUTIONS = [
  resolution(),
  resolution({ touchesOutsideConflictHunks: true }),
  resolution({ conflictHunks: [] }),
  resolution({ semanticConflictWith: "chg_upstream", touchesOutsideConflictHunks: true }),
  resolution({ truncated: true }),
  resolution({ status: "skipped" }),
  resolution({ status: "error", note: "x" }),
];

function expectConsistent(r: ClassifyResult, label: string): void {
  for (let i = 1; i < r.reasons.length; i++) {
    const a = r.reasons[i - 1]!;
    const b = r.reasons[i]!;
    expect(a.lane > b.lane || (a.lane === b.lane && a.code <= b.code), `${label}: sorted`).toBe(
      true,
    );
  }
  for (const reason of r.reasons) {
    expect(Object.hasOwn(REASON_CODES, reason.code), `${label}: ${reason.code}`).toBe(true);
    const spec = REASON_CODES[reason.code as ReasonCode];
    if (reason.code === "resolution.lane-kept") expect([1, 2]).toContain(reason.lane);
    else if (reason.code !== "signal.error.red-green") expect(reason.lane).toBe(spec.lane);
  }
  const nonShadow = r.reasons.filter((x) => x.code !== "shadow.lane0-disabled");
  expect(r.computedLane, label).toBe(Math.max(0, ...nonShadow.map((x) => x.lane)));
  expect(r.lane, label).toBe(Math.max(0, ...r.reasons.map((x) => x.lane)));
  expect(r.shadow, label).toBe(r.reasons.some((x) => x.code === "shadow.lane0-disabled"));
  if (r.blocked || r.requiresHumanApproval) expect(r.lane, label).toBe(2);
  expect(r.checklist.map((c) => c.gate)).toEqual([...GATES]);
  const gates = r.checklist.filter((c) => c.gate !== "lane0-enabled");
  expect(r.computedLane === 0, `${label}: computed 0 ⇔ gates pass`).toBe(
    gates.every((c) => c.passed === true),
  );
  expect(r.lane === 0, `${label}: lane 0 ⇔ every gate passes`).toBe(
    r.checklist.every((c) => c.passed === true),
  );
}

describe("properties", () => {
  it("adding a resolution item (any shape, any status) never lowers the lane", () => {
    for (const [name, input] of INPUTS) {
      const before = run(input());
      for (const [k, item] of RESOLUTIONS.entries()) {
        const after = run(withItems(input(), { ...item, id: `res:${k}` }));
        const msg = `${name} + resolution ${k}`;
        expect(after.computedLane >= before.computedLane, msg).toBe(true);
        expect(after.lane >= before.lane, msg).toBe(true);
        expect(after.blocked || !before.blocked, msg).toBe(true);
        expectConsistent(after, msg);
      }
    }
  });

  it("neverLower(prev, next) is max(prev, next), keeps next's reasons and stays consistent", () => {
    // Each input alone, inside the hunks, outside them, and failed: 56 results, 3136 pairs.
    const results = INPUTS.flatMap(([name, input]) => [
      [name, run(input())] as const,
      ...[0, 1, 6].map(
        (k) => [`${name}+res${k}`, run(withItems(input(), RESOLUTIONS[k]!))] as const,
      ),
    ]);
    for (const [pn, prev] of results) {
      for (const [nn, next] of results) {
        const label = `${pn} → ${nn}`;
        const r = neverLower(prev, next);
        expect(r.lane, label).toBe(Math.max(prev.lane, next.lane));
        expect(r.computedLane >= Math.max(prev.computedLane, next.computedLane), label).toBe(true);
        expect(r.requiresHumanApproval, label).toBe(
          prev.requiresHumanApproval || next.requiresHumanApproval,
        );
        expect(r.blocked, label).toBe(next.blocked);
        const lowered = next.lane < prev.lane || next.computedLane < prev.computedLane;
        expect(
          r.reasons.some((x) => x.code === "resolution.lane-kept"),
          label,
        ).toBe(lowered);
        const kept = new Set(r.reasons.map((x) => JSON.stringify(x)));
        const missing = next.reasons.filter(
          (x) => !kept.has(JSON.stringify(x)) && !(lowered && x.code === "shadow.lane0-disabled"),
        );
        expect(missing, label).toEqual([]);
        expectConsistent(r, label);
        // Idempotent: flooring twice changes nothing.
        expect(neverLower(prev, r), label).toStrictEqual(r);
      }
    }
  });
});
