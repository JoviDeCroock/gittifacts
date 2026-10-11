import { describe, expect, it } from "vitest";
import type { GettingStarted } from "../src/api/getting-started.js";
import { agentPrompt, buildPrompt, checklistView, durationLabel } from "../src/lib/getting-started.js";

const NEW: GettingStarted = {
  projects: 0,
  agent: { connected: false, name: null },
  firstGreen: null,
  latestBootstrap: null,
  repo: { connected: false, via: null },
  plan: null,
  review: null,
  firstMerge: null,
};

const plan = (approved: boolean): NonNullable<GettingStarted["plan"]> => ({
  approved,
  planId: "plan_sample_1",
  title: "Add GET /version",
  status: approved ? "approved" : "draft",
  repoId: "r_1",
  repoName: "workers-api-01",
  sample: true,
});

const review = (approved: boolean): NonNullable<GettingStarted["review"]> => ({
  approved,
  changeId: "ch2",
  title: "Add GET /version",
  status: approved ? "queued" : "awaiting-review",
  repoId: "r_1",
});

const MERGE: NonNullable<GettingStarted["firstMerge"]> = {
  projectId: "r_1",
  projectName: "workers-api-01",
  changeId: "ch2",
  title: "Add GET /version",
  at: "2026-10-11T10:05:42.000Z",
  msToFirstMerge: 342_000,
};

const states = (gs: GettingStarted, dismissed = false) =>
  Object.fromEntries(checklistView(gs, dismissed).steps.map((s) => [s.id, s.state]));

describe("getting-started checklist: the golden path", () => {
  it("a brand-new account: five steps to do, in order, shown in full", () => {
    const v = checklistView(NEW, false);
    expect(v.steps.map((s) => s.id)).toEqual(["repo", "agent", "plan", "review", "merge"]);
    expect(Object.values(states(NEW))).toEqual(["todo", "todo", "todo", "todo", "todo"]);
    expect(v).toMatchObject({ done: 0, allDone: false, mode: "full" });
  });

  it("ticks each step from real state", () => {
    // A template repo counts as a repo (the old "Bring a repo" step only ticked for imports).
    expect(states({ ...NEW, projects: 1 }).repo).toBe("done");
    expect(states({ ...NEW, agent: { connected: true, name: "fleet-coder" } }).agent).toBe("done");
    expect(states({ ...NEW, plan: plan(false) }).plan).toBe("todo");
    expect(states({ ...NEW, plan: plan(true) }).plan).toBe("done");
    expect(states({ ...NEW, review: review(false) }).review).toBe("todo");
    expect(states({ ...NEW, review: review(true) }).review).toBe("done");
    expect(states({ ...NEW, firstMerge: MERGE }).merge).toBe("done");
  });

  it("an approved Change is landing: the merge step runs until it merged", () => {
    expect(states({ ...NEW, review: review(true) }).merge).toBe("running");
    expect(states({ ...NEW, review: review(true), firstMerge: MERGE }).merge).toBe("done");
  });

  it("all done collapses to the banner; dismissed hides it (and an unfinished one)", () => {
    const all: GettingStarted = {
      ...NEW,
      projects: 1,
      agent: { connected: true, name: "fleet-coder" },
      plan: plan(true),
      review: review(true),
      firstMerge: MERGE,
    };
    expect(checklistView(all, false)).toMatchObject({ done: 5, allDone: true, mode: "banner" });
    expect(checklistView(all, true).mode).toBe("hidden");
    expect(checklistView(NEW, true).mode).toBe("hidden");
  });

  it("formats durations and the agent prompts", () => {
    expect(durationLabel(38_400)).toBe("38 s");
    expect(durationLabel(60_000)).toBe("1 min");
    expect(durationLabel(72_000)).toBe("1 min 12 s");
    expect(durationLabel(342_000)).toBe("5 min 42 s");
    expect(durationLabel(7_500_000)).toBe("2 h 5 min");
    const origin = "https://gittifacts.decroockjovi.workers.dev";
    expect(agentPrompt(origin)).toBe(`use ${origin}/start`);
    expect(buildPrompt(origin, "r_1", "plan_sample_1")).toBe(
      `Use ${origin}/start. In repo r_1, build plan plan_sample_1.`,
    );
  });
});
