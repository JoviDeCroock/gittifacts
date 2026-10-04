import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sortStrings } from "../src/paths.js";
import { codes, raisedCodes, run, withoutKind } from "./helpers.js";
import {
  codemodRename,
  pureBugfixWithRegressionTest,
  SCENARIOS,
  type Scenario,
} from "./scenarios.js";

function expectScenario(s: Scenario): void {
  const r = run(s.input);
  const why = `${s.fixture}: raised ${JSON.stringify(raisedCodes(r))}`;
  expect(r.computedLane, why).toBe(s.expected.computedLane);
  expect(r.lane, why).toBe(s.expected.lane);
  expect(r.shadow, why).toBe(s.expected.shadow);
  expect(r.blocked, why).toBe(s.expected.blocked);
  expect(r.requiresHumanApproval, why).toBe(s.expected.requiresHumanApproval);
  for (const code of s.expected.includes) expect(codes(r), why).toContain(code);
  for (const code of s.expected.excludes) expect(codes(r), why).not.toContain(code);
}

describe.each(Object.entries(SCENARIOS))("fixture scenario %s", (_name, build) => {
  it.each([false, true])("matches its expectations with lane0Enabled=%s", (lane0Enabled) => {
    expectScenario(build({ lane0Enabled }));
  });
});

describe("fixture scenario specifics", () => {
  it("pure bugfix: computed 0; Lane 1 shadowed when Lane 0 is disabled; Lane 0 when enabled", () => {
    const off = run(pureBugfixWithRegressionTest({ lane0Enabled: false }).input);
    expect([off.computedLane, off.lane, off.shadow]).toEqual([0, 1, true]);
    const on = run(pureBugfixWithRegressionTest({ lane0Enabled: true }).input);
    expect([on.computedLane, on.lane, on.shadow]).toEqual([0, 0, false]);
  });

  it("codemod: size subtraction makes a 48-file / 1090-line rename fit in Lane 0", () => {
    const s = codemodRename({ lane0Enabled: true, extraFiles: 45 });
    expect(s.input.diffStats?.files.length).toBe(48);
    expect((s.input.diffStats?.additions ?? 0) + (s.input.diffStats?.deletions ?? 0)).toBe(1090);
    expectScenario(s);
    const r = run(s.input);
    expect(r.lane).toBe(0);
    expect(r.reasons.find((x) => x.code === "size.ok")?.message).toContain(
      "0 changed line(s) in 0 file(s)",
    );
  });

  it("codemod: the same rename without a verified transform is Lane 2 on size", () => {
    const r = run(
      withoutKind(codemodRename({ lane0Enabled: true, extraFiles: 45 }).input, "transform"),
    );
    expect(r.computedLane).toBe(2);
    expect(codes(r)).toEqual(
      expect.arrayContaining([
        "size.lines-over-lane1",
        "size.files-over-lane1",
        "transform.unverified",
      ]),
    );
  });
});

/**
 * The scenarios mirror fixtures/<name>/fixture.json (owned by the fixtures work). Keep the lanes
 * and changed files in sync so integration tests over real fixtures and these unit scenarios
 * can't silently diverge. Reason codes are compared in the integration tests, not here.
 */
describe("scenarios mirror fixtures/*/fixture.json", () => {
  interface FixtureJson {
    claim: { category: string };
    plan: Record<string, unknown> & { scopePaths: string[] };
    expected: {
      computedLane: number;
      laneWithShadow: number;
      evidence: { changedFiles: string[] };
    };
  }
  const root = new URL("../../../fixtures/", import.meta.url);

  it.each(Object.entries(SCENARIOS))("%s", (name, build) => {
    const path = new URL(`${name}/fixture.json`, root);
    if (!existsSync(path)) return; // fixture not materialised in this checkout
    const fixture = JSON.parse(readFileSync(path, "utf8")) as FixtureJson;
    const s = build({ lane0Enabled: false });
    expect(s.expected.computedLane).toBe(fixture.expected.computedLane);
    expect(s.expected.lane).toBe(fixture.expected.laneWithShadow);
    expect(s.input.change.category).toBe(fixture.claim.category);
    expect(s.input.plan?.scopePaths).toEqual(fixture.plan.scopePaths);
    // The whole Plan text, not only its scope: a live judge reads every criterion, and the live
    // contract run drafts its Plans from fixture.json (a placeholder criterion once leaked there).
    for (const k of [
      "title",
      "intent",
      "acceptanceCriteria",
      "outOfScope",
      "riskDeclarations",
    ] as const) {
      expect(s.input.plan?.[k], `${name} plan.${k}`).toEqual(fixture.plan[k]);
    }
    expect(sortStrings(s.input.diffStats?.files.map((f) => f.path) ?? [])).toEqual(
      sortStrings(fixture.expected.evidence.changedFiles),
    );
  });
});
