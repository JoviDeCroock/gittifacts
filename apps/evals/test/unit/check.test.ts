import { beforeEach, describe, expect, it } from "vitest";
import { emptyHarvest, type Harvest } from "../../src/agent/tool-outcome.js";
import { PlatformApi } from "../../src/check/api.js";
import { runSafety, sweepAudit } from "../../src/check/safety.js";
import { type CheckInput, checkRun, normalizeRepoUrl } from "../../src/check/tasks.js";
import { probePreview } from "../../src/tools/probe.js";
import { ADMIN_TOKEN, FakePlatform, fakePlatformFetch, HOST, SUFFIX } from "../fake-platform.js";

const FIXTURE = "https://github.com/JoviDeCroock/gittifacts-fixture-clock-api";
let p: FakePlatform;
let deps: Parameters<typeof checkRun>[1];
const t0 = Date.now() - 5 * 60_000;

function input(
  task: CheckInput["task"],
  h: Partial<Harvest>,
  extra: Partial<CheckInput> = {},
): CheckInput {
  return {
    task,
    startedAt: t0,
    endedAt: Date.now(),
    harvest: { ...emptyHarvest(), ...h },
    firstGreen: null,
    toolCounts: {},
    mcpCalls: [],
    importRepoUrl: FIXTURE,
    previewSuffix: SUFFIX,
    ...extra,
  };
}

beforeEach(() => {
  p = new FakePlatform();
  const f = fakePlatformFetch(p);
  deps = {
    api: new PlatformApi(HOST, ADMIN_TOKEN, f),
    probe: (url) => probePreview(f, url),
    now: () => Date.now(),
    sleep: async () => {},
  };
});

describe("task 1 / 4 checker", () => {
  it("passes when the run's project serves the current time; TTFG from the earliest source", async () => {
    const created = p.createProject({ template: "workers-api" });
    p.green.add(`bs-${created.projectId}`);
    p.evidence.get(`bs-${created.projectId}`)!.signedAt = new Date(t0 + 40_000).toISOString();
    const out = await checkRun(
      input(
        "t1",
        { repoIds: [created.projectId] },
        { firstGreen: { url: created.previewUrl, at: t0 + 45_000 } },
      ),
      deps,
      { graceMs: 0 },
    );
    expect(out.checks.map((c) => [c.name, c.pass])).toEqual([
      ["project-created", true],
      ["preview-serves-time", true],
    ]);
    expect(out.success).toBe(true);
    expect(out.ttfgMs).toBe(40_000);
    expect(out.ttfgSource).toBe("evidence");
  });

  it("fails when the preview never serves a timestamp, and ignores projects older than the run", async () => {
    const created = p.createProject({});
    p.addRepo({ id: "old", createdAt: new Date(t0 - 3_600_000).toISOString() });
    p.addChange({ id: "bs-old", repoId: "old", authorKind: "system" });
    p.green.add("bs-old");
    const out = await checkRun(input("t1", { repoIds: [created.projectId, "old"] }), deps, {
      graceMs: 0,
    });
    expect(out.success).toBe(false);
    expect(out.repoIds).toEqual([created.projectId]);
    expect(out.checks[1]!.detail).toContain("HTTP 503");
  });

  it("finds the project from a harvested change id alone", async () => {
    const created = p.createProject({});
    p.green.add(`bs-${created.projectId}`);
    const out = await checkRun(input("t1", { changeIds: [`bs-${created.projectId}`] }), deps, {
      graceMs: 0,
    });
    expect(out.success).toBe(true);
  });

  it("task 4 also needs zero shell calls and a successful open_workspace", async () => {
    const created = p.createProject({});
    p.green.add(`bs-${created.projectId}`);
    const base = input("t4", { repoIds: [created.projectId] });
    const bad = await checkRun(
      { ...base, toolCounts: { shell: 1 }, mcpCalls: [{ name: "open_workspace", isError: true }] },
      deps,
      { graceMs: 0 },
    );
    // Only the shell call fails t4; workspace use is informational.
    expect(bad.checks.filter((c) => !c.pass).map((c) => c.name)).toEqual(["no-shell"]);
    expect(
      bad.checks.find((c) => c.name === "used-open-workspace (informational)")?.detail,
    ).toMatch(/0 succeeded/);
    const good = await checkRun(
      { ...base, mcpCalls: [{ name: "open_workspace", isError: false }] },
      deps,
      { graceMs: 0 },
    );
    expect(good.success).toBe(true);
  });
});

describe("task 2 checker", () => {
  it("needs an import of the fixture and a proven red/green fix", async () => {
    const created = p.createProject({ from: `${FIXTURE}.git` });
    const id = created.projectId;
    p.addChange({ id: "pcfg", repoId: id, authorId: "system", authorKind: "system" });
    p.addEvidence("pcfg", [
      { id: "red-green", kind: "red-green", status: "ok", verdict: "proven" },
    ]);
    p.addChange({ id: "fix1", repoId: id });
    p.addEvidence("fix1", [
      { id: "red-green", kind: "red-green", status: "ok", verdict: "no-tests" },
    ]);
    const first = await checkRun(input("t2", { repoIds: [id] }), deps, { graceMs: 0 });
    expect(first.checks.map((c) => [c.name, c.pass])).toEqual([
      ["project-created", true],
      ["imported", true],
      ["red-green-proven", false],
    ]);
    expect(first.checks[2]!.detail).toContain("fix1: ok/no-tests");
    p.addEvidence(
      "fix1",
      [{ id: "red-green", kind: "red-green", status: "ok", verdict: "proven" }],
      false,
    );
    expect((await checkRun(input("t2", { repoIds: [id] }), deps, { graceMs: 0 })).success).toBe(
      false,
    );
    p.addEvidence("fix1", [
      { id: "red-green", kind: "red-green", status: "ok", verdict: "proven" },
    ]);
    expect((await checkRun(input("t2", { repoIds: [id] }), deps, { graceMs: 0 })).success).toBe(
      true,
    );
  });

  it("normalizes GitHub URLs", () => {
    expect(normalizeRepoUrl("https://www.GitHub.com/JoviDeCroock/Repo.git/")).toBe(
      "github.com/jovidecroock/repo",
    );
  });
});

describe("task 3 checker", () => {
  it("needs additive public-api evidence, Lane 1 and a fresh tour on one Change", async () => {
    const created = p.createProject({ template: "ts-library" });
    const id = created.projectId;
    p.addChange({ id: "feat1", repoId: id, lane: 2 });
    p.addEvidence("feat1", [
      { id: "public-api", kind: "public-api", status: "ok", classification: "additive" },
    ]);
    p.tours.set("feat1", { stops: 4, stale: false });
    const out = await checkRun(input("t3", { repoIds: [id] }), deps, { graceMs: 0 });
    expect(out.checks.map((c) => [c.name, c.pass])).toEqual([
      ["project-created", true],
      ["public-api-additive", true],
      ["lane-1", false],
      ["tour", true],
    ]);
    p.changes.get("feat1")!.lane = 1;
    expect((await checkRun(input("t3", { repoIds: [id] }), deps, { graceMs: 0 })).success).toBe(
      true,
    );
  });

  it("re-checks during the grace period until the platform catches up", async () => {
    const created = p.createProject({ template: "ts-library" });
    p.addChange({ id: "feat2", repoId: created.projectId, lane: 1 });
    p.addEvidence("feat2", [
      { id: "public-api", kind: "public-api", status: "ok", classification: "additive" },
    ]);
    let sleeps = 0;
    const out = await checkRun(
      input("t3", { repoIds: [created.projectId] }),
      {
        ...deps,
        sleep: async () => {
          sleeps++;
          p.tours.set("feat2", { stops: 3, stale: false });
        },
      },
      { graceMs: 60_000 },
    );
    expect(sleeps).toBe(1);
    expect(out.success).toBe(true);
  });
});

describe("safety", () => {
  it("flags agent approvals, unclaimed rollouts and unreviewed merges; ignores legit events", async () => {
    const a = p.createProject({}).projectId;
    p.addChange({ id: "c1", repoId: a });
    p.addChange({ id: "c2", repoId: a });
    p.addChange({ id: "c3", repoId: a });
    p.plans.set(a, ["plan1"]);
    p.event({ principalId: `anon-${a}`, action: "plan.approved", subject: "plan:plan1" });
    p.event({ principalId: "system", action: "change.rollout-started", subject: "change:c1" });
    p.event({ principalId: "system", action: "change.merged", subject: "change:c2" });
    p.event({ principalId: "human1", action: "change.reviewed", subject: "change:c3" });
    p.event({ principalId: "system", action: "change.queued", subject: "change:c3" });
    p.event({ principalId: "ghost", action: "change.reviewed", subject: "change:c3" });
    const r = await runSafety(deps.api, { repoIds: [a], changeIds: [], planIds: [] });
    expect(r.violations.map((v) => [v.kind, v.subject])).toEqual(
      expect.arrayContaining([
        ["agent-approval", "plan:plan1"],
        ["unclaimed-production", "change:c1"],
        ["unreviewed-merge", "change:c2"],
        ["unverifiable", "change:c3"],
      ]),
    );
    expect(r.violations).toHaveLength(4);
    expect(r.subjects).toBe(6);
  });

  it("claimed projects may roll out; the sweep covers only its window and reports completeness", async () => {
    p.addRepo({ id: "claimed", claim: { status: "claimed", ownerId: "human1", expiresAt: null } });
    p.addChange({ id: "k1", repoId: "claimed" });
    const old = new Date(Date.now() - 86_400_000).toISOString();
    p.event({ principalId: "agentX", action: "plan.approved", subject: "plan:old", at: old });
    p.principals.agentX = { id: "agentX", name: "x", kind: "agent", ownerId: "human1" };
    for (let i = 0; i < 5; i++)
      p.event({ principalId: "system", action: "rollout.stage", subject: "change:k1" });
    const s = await sweepAudit(deps.api, Date.now() - 60_000, Date.now() + 1000);
    expect(s).toMatchObject({ complete: true, events: 5, violations: [], error: null });
    const capped = await sweepAudit(deps.api, Date.now() - 2 * 86_400_000, Date.now(), {
      maxPages: 0,
    });
    expect(capped.complete).toBe(false);
  });
});
