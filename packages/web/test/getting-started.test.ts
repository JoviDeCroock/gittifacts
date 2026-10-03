import { describe, expect, it } from "vitest";
import type { GettingStarted } from "../src/api/getting-started.js";
import { agentPrompt, checklistView, durationLabel } from "../src/lib/getting-started.js";

const NEW: GettingStarted = {
  projects: 0,
  agent: { connected: false, name: null },
  firstGreen: null,
  latestBootstrap: null,
  repo: { connected: false, via: null },
};

const bootstrap = (status: NonNullable<GettingStarted["latestBootstrap"]>["status"]) => ({
  projectId: "r_1",
  projectName: "static-site-01",
  template: "static-site",
  changeId: "ch1",
  previewUrl: "https://p-ch1-pv.example.dev",
  createdAt: "2026-10-03T10:00:00.000Z",
  status,
  msToFirstGreen: status === "green" ? 38_000 : null,
});

const GREEN = {
  projectId: "r_1",
  projectName: "static-site-01",
  changeId: "ch1",
  previewUrl: "https://p-ch1-pv.example.dev",
  at: "2026-10-03T10:00:38.000Z",
  msToFirstGreen: 38_000,
};

const states = (gs: GettingStarted, dismissed = false) =>
  Object.fromEntries(checklistView(gs, dismissed).steps.map((s) => [s.id, s.state]));

describe("getting-started checklist", () => {
  it("a brand-new account: three steps to do, shown in full", () => {
    const v = checklistView(NEW, false);
    expect(v.steps.map((s) => s.id)).toEqual(["agent", "try", "repo"]);
    expect(states(NEW)).toEqual({ agent: "todo", try: "todo", repo: "todo" });
    expect(v).toMatchObject({ done: 0, allDone: false, mode: "full" });
  });

  it("ticks each step from real state", () => {
    expect(states({ ...NEW, agent: { connected: true, name: "fleet-coder" } }).agent).toBe("done");
    expect(states({ ...NEW, repo: { connected: true, via: "github-app" } }).repo).toBe("done");
    expect(states({ ...NEW, firstGreen: GREEN }).try).toBe("done");
  });

  it("follows a first run: running, then done, or failed", () => {
    expect(states({ ...NEW, projects: 1, latestBootstrap: bootstrap("running") }).try).toBe(
      "running",
    );
    expect(states({ ...NEW, projects: 1, latestBootstrap: bootstrap("ci-failed") }).try).toBe(
      "failed",
    );
    expect(
      states({ ...NEW, projects: 1, latestBootstrap: bootstrap("green"), firstGreen: GREEN }).try,
    ).toBe("done");
    // An earlier green stays done while a newer project runs.
    expect(
      states({ ...NEW, projects: 2, latestBootstrap: bootstrap("running"), firstGreen: GREEN }).try,
    ).toBe("done");
  });

  it("all done collapses to the banner; dismissed hides it (and an unfinished one)", () => {
    const all: GettingStarted = {
      projects: 2,
      agent: { connected: true, name: "fleet-coder" },
      firstGreen: GREEN,
      latestBootstrap: bootstrap("green"),
      repo: { connected: true, via: "import" },
    };
    expect(checklistView(all, false)).toMatchObject({ done: 3, allDone: true, mode: "banner" });
    expect(checklistView(all, true).mode).toBe("hidden");
    expect(checklistView(NEW, true).mode).toBe("hidden");
  });

  it("formats the first green's duration and the agent prompt", () => {
    expect(durationLabel(38_400)).toBe("38 s");
    expect(durationLabel(60_000)).toBe("1 min");
    expect(durationLabel(72_000)).toBe("1 min 12 s");
    expect(agentPrompt("https://gittifacts.decroockjovi.workers.dev")).toBe(
      "use https://gittifacts.decroockjovi.workers.dev/start",
    );
  });
});
