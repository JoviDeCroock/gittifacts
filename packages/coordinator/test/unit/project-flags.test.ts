/**
 * Cross-tenant flag isolation: one Flagship app per project. A project's flags live in its own
 * app, its Worker binds only that app, and two projects never share one.
 */
import type { Repo } from "@app/domain";
import { describe, expect, it } from "vitest";
import { FakeClock, FakeFlags, FakeStore } from "../../src/fakes/index.js";
import { ensureProjectFlagApp, projectFlagAppName } from "../../src/project-flags.js";
import { reload, scenario, startAndPush } from "./helpers.js";

const fast = {
  stages: [10, 100],
  stageMinutes: 2,
  watchMinutes: 3,
  maxErrorRateIncrease: 0.01,
  maxNewIssueGroups: 0,
  minRequests: 50,
};

function repoOf(id: string, over: Partial<Repo> = {}): Repo {
  return {
    id,
    namespace: "ns",
    artifactsName: id,
    name: id,
    defaultBranch: "main",
    jurisdiction: "eu",
    importedFrom: null,
    policy: {} as Repo["policy"],
    policySha: null,
    deployTarget: `gf-${id}-api`,
    claim: { status: "claimed", ownerId: "hu_1", expiresAt: null },
    template: null,
    createdAt: "2026-10-02T00:00:00.000Z",
    ...over,
  };
}

describe("ensureProjectFlagApp", () => {
  it("creates gf-<repoId> once, records it, and gives two projects two apps", async () => {
    const store = new FakeStore(new FakeClock());
    const flags = new FakeFlags();
    await store.insertRepo(repoOf("r1"));
    await store.insertRepo(repoOf("r2"));
    const a1 = await ensureProjectFlagApp({ store, flags }, "r1");
    expect(await ensureProjectFlagApp({ store, flags }, "r1")).toBe(a1);
    const a2 = await ensureProjectFlagApp({ store, flags }, "r2");
    expect(a1).not.toBe(a2);
    expect(flags.apps.get(a1)?.name).toBe(projectFlagAppName("r1"));
    expect(flags.apps.get(a2)?.name).toBe("gf-r2");
    expect((await store.getRepo("r1"))?.flagshipAppId).toBe(a1);
    expect((await store.getRepo("r2"))?.flagshipAppId).toBe(a2);
    expect(flags.apps.size).toBe(2);
  });

  it("keeps the first app recorded for the repo and deletes one created in a race", async () => {
    const store = new FakeStore(new FakeClock());
    const flags = new FakeFlags();
    const stale = repoOf("r1");
    await store.insertRepo(stale);
    // A concurrent writer recorded its app after we read the repo (without one).
    const winner = await flags.ensureApp("gf-r1-winner");
    await store.setRepoFlagshipApp("r1", winner);
    expect(await ensureProjectFlagApp({ store, flags }, stale)).toBe(winner);
    expect(flags.deleted).toHaveLength(1);
    expect([...flags.apps.keys()]).toEqual([winner]);
  });

  it("names fit Flagship's 1–64 [A-Za-z0-9_-]", () => {
    expect(projectFlagAppName("k3j9.abc/def")).toBe("gf-k3j9-abc-def");
    expect(projectFlagAppName("x".repeat(100))).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });
});

describe("rollouts use the project's own app", () => {
  it("the flag, the Worker's FLAGS binding and the kill all target the project's app", async () => {
    const s = await scenario({
      deployTarget: "api",
      policy: { rollout: fast, autoMergeVerifiedReverts: true },
    });
    s.ports.deployer.live.set("api", [{ versionId: "v0", percentage: 100 }]);
    // Another project already has its own app, with a flag in it.
    const other = await s.ports.flags.ensureApp("gf-other");
    await s.ports.flags.ensureChangeFlag(other, "theirs", { enabled: true, description: "" });
    s.ports.telemetry.queue.push({ errorRate: 0.001 }, { errorRate: 0.2, baselineErrorRate: 0 });
    const started = await startAndPush(s);
    await s.coordinator.submitReview(s.reviewer, started.change.id, { decision: "approve" });
    await s.settle();
    const change = await reload(s, started.change.id);

    const appId = (await s.ports.store.getRepo(s.repo.id))?.flagshipAppId;
    expect(appId).toBeTruthy();
    expect(appId).not.toBe(other);
    expect(s.ports.flags.apps.get(appId as string)?.name).toBe(projectFlagAppName(s.repo.id));
    expect(s.ports.deployer.uploads[0]?.flagshipAppId).toBe(appId);
    const ours = s.ports.flags.history.filter((h) => h.key === `change-${change.id}`);
    expect(ours.map((h) => [h.appId, h.enabled])).toEqual([
      [appId, true],
      [appId, false],
    ]);
    // The other project's app holds only its own flag, untouched.
    expect([...(s.ports.flags.apps.get(other)?.flags ?? [])]).toEqual([["change-theirs", true]]);
  });
});
