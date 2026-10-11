import { describe, expect, it } from "vitest";
import {
  type AttemptFacts,
  AttemptsRanking,
  attemptReasons,
  rankAttempts,
  signalsFromReasons,
} from "../src/attempts.js";

const T0 = "2026-10-11T10:00:00.000Z";

function attempt(id: string, over: Partial<AttemptFacts> = {}): AttemptFacts {
  return {
    changeId: id,
    title: `Attempt ${id}`,
    status: "awaiting-review",
    headSha: "a".repeat(40),
    lane: 1,
    author: { id: `agent-${id}`, name: `Agent ${id}`, kind: "agent" },
    ci: "passed",
    tests: { state: "passed", passed: 12, failed: 0 },
    redGreen: "proven",
    scope: { state: "within", detail: null },
    publicApi: "none",
    coverage: null,
    mutation: null,
    diff: { lines: 42, files: 2 },
    timeToGreenMs: 240_000,
    startedAt: T0,
    ...over,
  };
}

const order = (facts: AttemptFacts[]) => rankAttempts(facts).attempts.map((a) => a.changeId);

describe("rankAttempts", () => {
  it("puts the lowest lane first and recommends it, with readable reasons", () => {
    const r = rankAttempts([
      attempt("drift", { lane: 2, scope: { state: "drift", detail: "Files outside: README.md" } }),
      attempt("clean"),
      attempt("red", {
        status: "failing",
        lane: 2,
        ci: "failed",
        tests: { state: "failing", passed: 10, failed: 2 },
      }),
    ]);
    expect(AttemptsRanking.parse(r)).toEqual(r);
    expect(r.attempts.map((a) => a.changeId)).toEqual(["clean", "drift", "red"]);
    expect(r.recommended).toMatchObject({ changeId: "clean", provisional: false });
    expect(r.attempts[0]?.reasons.slice(0, 4)).toEqual([
      "Lane 1",
      "tests pass (12)",
      "red/green proven",
      "within plan scope",
    ]);
    expect(r.attempts[0]?.reasons).toContain("42 lines");
    expect(r.attempts[1]?.reasons).toContain("scope drift");
    expect(r.attempts[2]?.reasons).toEqual(
      expect.arrayContaining(["CI failed", "2 tests failing"]),
    );
    expect(r.attempts.map((a) => a.rank)).toEqual([1, 2, 3]);
    expect(r.summary).toBe("3 attempts: 3 finished");
  });

  it("ranks failing CI below passing even at a lower lane, and never recommends it", () => {
    const r = rankAttempts([
      attempt("red-lane0", { status: "failing", lane: 0, ci: "failed" }),
      attempt("green-lane2", { lane: 2 }),
    ]);
    expect(r.attempts.map((a) => a.changeId)).toEqual(["green-lane2", "red-lane0"]);
    expect(
      rankAttempts([attempt("red", { status: "failing", ci: "failed" })]).recommended,
    ).toBeNull();
  });

  it("treats missing or errored evidence as worse, never better", () => {
    expect(
      order([
        attempt("unknown-tests", { tests: { state: "unknown", passed: null, failed: null } }),
        attempt("measured"),
      ]),
    ).toEqual(["measured", "unknown-tests"]);
    expect(order([attempt("no-rg", { redGreen: "unknown" }), attempt("rg")])).toEqual([
      "rg",
      "no-rg",
    ]);
    expect(
      order([
        attempt("no-scope", { scope: { state: "unknown", detail: null } }),
        attempt("scoped"),
      ]),
    ).toEqual(["scoped", "no-scope"]);
    expect(order([attempt("no-cov"), attempt("cov", { coverage: 0.2 })])).toEqual([
      "cov",
      "no-cov",
    ]);
    expect(
      order([
        attempt("api?", { publicApi: "unknown" }),
        attempt("api-add", { publicApi: "additive" }),
      ]),
    ).toEqual(["api-add", "api?"]);
    expect(order([attempt("no-lane", { lane: null }), attempt("lane2", { lane: 2 })])).toEqual([
      "lane2",
      "no-lane",
    ]);
    expect(order([attempt("ci?", { ci: "unknown" }), attempt("ci", { lane: 2 })])).toEqual([
      "ci",
      "ci?",
    ]);
  });

  it("orders ties by red/green, scope, coverage, mutation, public API, diff size, then time to green", () => {
    expect(order([attempt("np", { redGreen: "not-proven" }), attempt("p")])).toEqual(["p", "np"]);
    expect(
      order([attempt("drift", { scope: { state: "drift", detail: null } }), attempt("in")]),
    ).toEqual(["in", "drift"]);
    expect(order([attempt("c80", { coverage: 0.8 }), attempt("c95", { coverage: 0.95 })])).toEqual([
      "c95",
      "c80",
    ]);
    expect(order([attempt("m5", { mutation: 0.5 }), attempt("m9", { mutation: 0.9 })])).toEqual([
      "m9",
      "m5",
    ]);
    expect(order([attempt("break", { publicApi: "breaking" }), attempt("none")])).toEqual([
      "none",
      "break",
    ]);
    expect(
      order([
        attempt("big", { diff: { lines: 400, files: 9 } }),
        attempt("small", { diff: { lines: 12, files: 1 } }),
      ]),
    ).toEqual(["small", "big"]);
    expect(
      order([
        attempt("slow", { timeToGreenMs: 900_000 }),
        attempt("fast", { timeToGreenMs: 60_000 }),
      ]),
    ).toEqual(["fast", "slow"]);
  });

  it("is deterministic whatever the input order", () => {
    const facts = [
      attempt("b"),
      attempt("a"),
      attempt("c", { lane: 2 }),
      attempt("d", { status: "running", lane: null, ci: "unknown" }),
    ];
    const once = rankAttempts(facts);
    expect(rankAttempts([...facts].reverse())).toEqual(once);
    expect(once.attempts.map((a) => a.changeId)).toEqual(["a", "b", "c", "d"]);
  });

  it("lists attempts still grading after finished ones and never recommends them over one", () => {
    const r = rankAttempts([
      attempt("grading", {
        status: "running",
        lane: null,
        ci: "unknown",
        tests: { state: "unknown", passed: null, failed: null },
        timeToGreenMs: null,
      }),
      attempt("done", { lane: 2 }),
    ]);
    expect(r.attempts.map((a) => [a.changeId, a.standing])).toEqual([
      ["done", "finished"],
      ["grading", "grading"],
    ]);
    expect(r.attempts[1]?.reasons[0]).toBe("still grading");
    expect(r.attempts[1]?.reasons).not.toContain("tests not measured");
    expect(r.recommended?.changeId).toBe("done");
    // A finished but red attempt still blocks a grading one from being recommended.
    const red = rankAttempts([
      attempt("grading", { status: "running", lane: null, ci: "unknown" }),
      attempt("red", { status: "failing", ci: "failed" }),
    ]);
    expect(red.attempts.map((a) => a.changeId)).toEqual(["red", "grading"]);
    expect(red.recommended).toBeNull();
  });

  it("recommends the leader provisionally when nothing has finished", () => {
    const r = rankAttempts([
      attempt("b", { status: "running", lane: null, ci: "unknown" }),
      attempt("a", {
        status: "awaiting-push",
        headSha: null,
        lane: null,
        ci: "unknown",
        diff: null,
      }),
    ]);
    expect(r.recommended).toMatchObject({ provisional: true });
    expect(r.attempts.every((a) => !a.pickable)).toBe(true);
    expect(r.summary).toBe("2 attempts: 2 still grading");
  });

  it("puts closed attempts last, and marks only reviewable or approved ones pickable", () => {
    const r = rankAttempts([
      attempt("closed", { status: "abandoned", lane: 0 }),
      attempt("queued", { status: "queued", lane: 2 }),
      attempt("review"),
    ]);
    expect(r.attempts.map((a) => [a.changeId, a.pickable])).toEqual([
      ["review", true],
      ["queued", true],
      ["closed", false],
    ]);
    expect(r.attempts[2]?.reasons[0]).toBe("closed");
  });

  it("reads green time and not-measured states in words", () => {
    expect(
      attemptReasons(attempt("x", { timeToGreenMs: 250_000, coverage: 0.914, mutation: 0.9 })),
    ).toEqual([
      "Lane 1",
      "tests pass (12)",
      "red/green proven",
      "within plan scope",
      "coverage 91%",
      "mutation 90%",
      "42 lines",
      "green in 4m 10s",
    ]);
    expect(
      attemptReasons(
        attempt("y", {
          ci: "unknown",
          tests: { state: "unknown", passed: null, failed: null },
          redGreen: "unknown",
          scope: { state: "unknown", detail: null },
          publicApi: "unknown",
          diff: null,
          timeToGreenMs: null,
        }),
      ),
    ).toEqual([
      "Lane 1",
      "CI not measured",
      "tests not measured",
      "red/green not measured",
      "scope not checked",
      "public API not measured",
    ]);
  });
});

describe("signalsFromReasons", () => {
  const r = (...codes: string[]) => codes.map((code) => ({ code, message: `${code} message` }));

  it("reads the classifier's codes", () => {
    expect(
      signalsFromReasons(
        r("ci.passed", "tests.passed", "red-green.proven", "scope.within", "api.none"),
        "awaiting-review",
      ),
    ).toEqual({
      ci: "passed",
      testsState: "passed",
      redGreen: "proven",
      scope: { state: "within", detail: null },
      publicApi: "none",
    });
    const drift = signalsFromReasons(
      r("ci.passed", "scope.drift", "api.breaking", "red-green.not-required"),
      "awaiting-review",
    );
    expect(drift).toMatchObject({
      scope: { state: "drift", detail: "scope.drift message" },
      publicApi: "breaking",
      redGreen: "not-required",
    });
  });

  it("escalates anything missing, errored or absent to unknown, and failing status to failed CI", () => {
    expect(signalsFromReasons([], "awaiting-review")).toEqual({
      ci: "unknown",
      testsState: "unknown",
      redGreen: "unknown",
      scope: { state: "unknown", detail: null },
      publicApi: "unknown",
    });
    expect(signalsFromReasons([], "failing").ci).toBe("failed");
    expect(signalsFromReasons(r("ci.errored"), "failing").ci).toBe("unknown");
    expect(
      signalsFromReasons(r("tests.passed", "signal.error.test-run"), "awaiting-review").testsState,
    ).toBe("unknown");
    expect(
      signalsFromReasons(r("tests.passed", "tests.failing"), "awaiting-review").testsState,
    ).toBe("failing");
    expect(
      signalsFromReasons(r("api.none", "signal.error.public-api"), "awaiting-review").publicApi,
    ).toBe("unknown");
    expect(
      signalsFromReasons(r("scope.within", "signal.missing.diff-stats"), "awaiting-review").scope
        .state,
    ).toBe("unknown");
  });
});
