/**
 * `runContractSuite(factory)`: registers the contract scenarios as vitest tests against one host.
 * Every host must reach the same lane, evidence kinds and tour (riskiest stop) for the same
 * change; only the plumbing differs. Call it from a host package's test file.
 */
import { type HostCapabilities, laneZeroAction } from "@app/host";
import { describe, expect, it } from "vitest";
import { type FixtureTrees, loadFixture } from "./fixtures.js";
import type { ContractHost, ContractHostFactory } from "./harness.js";
import { contractReviewer, riskiestFile } from "./reviewer.js";
import {
  CONTRACT_SCENARIO_NAMES,
  CONTRACT_SCENARIOS,
  type ContractKind,
  type ContractScenario,
  type ContractScenarioName,
} from "./scenarios.js";

export const CONTRACT_TIMEOUT_MS = 60_000;

/** The routing a scenario expects, on this host's capabilities (Lane 0 may degrade). */
export function expectedAction(s: ContractScenario, caps: HostCapabilities) {
  return s.expected.action === "merge" ? laneZeroAction(caps).action : s.expected.action;
}

async function expectGraded(
  host: ContractHost,
  ref: Parameters<ContractHost["observe"]>[0],
  headSha: string,
  s: ContractScenario,
  fx: FixtureTrees,
): Promise<void> {
  const caps = host.adapter.capabilities();
  const meta = await host.adapter.getChange(ref);
  expect(meta.headSha).toBe(headSha);
  if (meta.category !== null) expect(meta.category).toBe(s.category);
  const diff = await host.adapter.diff(ref);
  expect(diff.headSha).toBe(headSha);
  if (fx.changedFiles !== null) {
    expect(diff.files.map((f) => f.path).sort()).toEqual([...fx.changedFiles].sort());
  }
  const o = await host.observe(ref, headSha);
  const e = s.expected;
  expect(o.verdict).toMatchObject({
    headSha,
    lane: e.lane,
    computedLane: e.computedLane,
    shadow: e.shadow,
    blocked: e.blocked,
    requiresHumanApproval: e.requiresHumanApproval,
  });
  for (const code of e.includes) expect(o.verdict?.reasons).toContain(code);
  for (const code of e.excludes) expect(o.verdict?.reasons).not.toContain(code);
  expect(o.action).toBe(expectedAction(s, caps));
  expect(o.evidence?.kinds).toEqual(e.evidenceKinds);
  expect(o.evidence?.verified).toBe(true);
  expect(riskiestFile(o.tour)).toBe(e.riskiestFile);
  if (o.tour !== null) expect(o.tour.headSha).toBe(headSha);
}

type Runner = (host: ContractHost, s: ContractScenario) => Promise<void>;

const grade: Runner = async (host, s) => {
  const fx = loadFixture(s.fixture);
  const { ref, headSha } = await host.open({
    scenario: s,
    base: fx.base,
    push: fx.push,
    title: fx.title,
  });
  await host.settle();
  await expectGraded(host, ref, headSha, s, fx);
};

const RUNNERS: Record<ContractKind, Runner> = {
  grade,

  /** Natively every change is a fork: agents never hold a write token for the main repo. */
  fork: async (host, s) => {
    const fx = loadFixture(s.fixture);
    const { ref, headSha } = await host.open({
      scenario: s,
      base: fx.base,
      push: fx.push,
      title: fx.title,
    });
    await host.settle();
    await expectGraded(host, ref, headSha, s, fx);
    const meta = await host.adapter.getChange(ref);
    expect(meta.source.fork).toBe(true);
    expect(host.adapter.capabilities().identityKinds).toContain(meta.author.kind);
    const checkout = await host.adapter.materialize(ref, headSha);
    expect(checkout).toMatchObject({ sha: headSha, writable: false, token: { scope: "read" } });
  },

  "force-push": async (host, s) => {
    if (s.firstFixture === undefined) throw new Error(`${s.name}: no first head`);
    const first = loadFixture(s.firstFixture);
    const fx = loadFixture(s.fixture);
    await host.holdRuns(true);
    const opened = await host.open({
      scenario: s,
      base: fx.base,
      push: first.push,
      title: fx.title,
    });
    // Mid-grading: the first head's evidence run is in flight, nothing is published yet.
    await host.settle();
    const during = await host.observe(opened.ref, opened.headSha);
    expect(during).toMatchObject({ run: "running", verdict: null });
    const head = await host.push(opened.ref, fx.push, { force: true });
    expect(head).not.toBe(opened.headSha);
    await host.holdRuns(false);
    await host.settle();
    const heads = await host.verdictHeads(opened.ref);
    expect(heads.length).toBeGreaterThan(0);
    expect(new Set(heads)).toEqual(new Set([head]));
    const old = await host.observe(opened.ref, opened.headSha);
    expect(old.verdict).toBeNull();
    expect(["superseded", "cancelled"]).toContain(old.run);
    await expectGraded(host, opened.ref, head, s, fx);
  },

  "stale-head": async (host, s) => {
    const fx = loadFixture(s.fixture);
    const { ref, headSha: first } = await host.open({
      scenario: s,
      base: fx.base,
      push: fx.push,
      title: fx.title,
    });
    await host.settle();
    expect((await host.observe(ref, first)).verdict?.headSha).toBe(first);
    // A small in-scope follow-up push (the test file gains a comment line).
    const path = "test/allocate.test.ts";
    const second = await host.push(
      ref,
      { [path]: `${fx.head[path] ?? ""}// re-pushed\n` },
      { force: false },
    );
    const merge = await host.adapter.merge(ref, { expectedHeadSha: first, method: "fast-forward" });
    expect(merge).toMatchObject({
      status: "refused",
      reason: "stale-head",
      currentHeadSha: second,
    });
    await host.settle();
    await expectGraded(host, ref, second, s, fx);
  },
};

export function runContractSuite(
  factory: ContractHostFactory,
  opts: { only?: readonly ContractScenarioName[] } = {},
): void {
  describe(`host contract: ${factory.name}`, () => {
    it("declares consistent capabilities", async () => {
      const host = await factory.create({ reviewer: contractReviewer() });
      const caps = host.adapter.capabilities();
      expect(caps.hasOwnMergeQueue && caps.hasHostMergeQueue).toBe(false);
      expect(caps.identityKinds.length).toBeGreaterThan(0);
      if (caps.hasOwnMergeQueue) expect(caps.canMerge).toBe(true);
      await host.dispose?.();
    });
    for (const name of opts.only ?? CONTRACT_SCENARIO_NAMES) {
      it(
        name,
        async () => {
          const s = CONTRACT_SCENARIOS[name]();
          const host = await factory.create({ reviewer: contractReviewer() });
          try {
            await RUNNERS[s.kind](host, s);
          } finally {
            await host.dispose?.();
          }
        },
        CONTRACT_TIMEOUT_MS,
      );
    }
  });
}
