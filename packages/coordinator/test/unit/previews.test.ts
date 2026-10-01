/** Worker-side preview and screenshot evidence in the ChangeWorkflow, and onboarding metrics. */
import { describe, expect, it } from "vitest";
import type { InitialCommitProvider } from "../../src/api.js";
import { FakeOnboarding, FakePreviews, principal } from "../../src/fakes/index.js";
import { reload, scenario, startAndPush } from "./helpers.js";

describe("preview evidence", () => {
  it("starts the preview from the build snapshot before sealing, then screenshots it", async () => {
    const s = await scenario({ policy: { previewRoutes: ["/", "/about/"] } });
    const previews = new FakePreviews();
    s.ports.previews = previews;
    const { change, headSha } = await startAndPush(s);

    expect(previews.starts).toHaveLength(1);
    expect(previews.starts[0]).toMatchObject({
      changeId: change.id,
      artifactsRepo: change.forkName,
      headSha,
      claimed: true,
      snapshots: { build: expect.stringContaining("snap-build-") },
    });
    const evidence = await s.ports.store.getEvidence(change.id, headSha);
    expect(evidence?.items.find((i) => i.kind === "preview")).toMatchObject({
      status: "ok",
      url: `https://p-${change.id}.preview.test`,
    });
    // Policy routes plus the plan's affected routes (none here).
    expect(previews.screenshotCalls[0]?.routes).toEqual(["/", "/about/"]);
    const shots = evidence?.items.find((i) => i.kind === "screenshots");
    expect(shots).toMatchObject({ status: "ok", shots: [{ route: "/" }, { route: "/about/" }] });
    // The bundle is still signed and verified after the re-seal.
    expect(change.lane).not.toBeNull();
    expect(change.laneReasons.map((r) => r.code)).not.toContain("signal.error.preview");
  });

  it("a preview that fails to start is an error item (raises the lane); no build is skipped", async () => {
    const s = await scenario({ policy: { lane0Enabled: true } });
    const previews = new FakePreviews();
    previews.outcome = () => ({ status: "error", url: null, reason: "snapshot unavailable" });
    s.ports.previews = previews;
    const { change, headSha } = await startAndPush(s);
    const evidence = await s.ports.store.getEvidence(change.id, headSha);
    expect(evidence?.items.find((i) => i.kind === "preview")).toMatchObject({
      status: "error",
      note: "snapshot unavailable",
    });
    expect(previews.screenshotCalls).toHaveLength(0);
    expect(change.laneReasons.map((r) => r.code)).toContain("signal.error.preview");
    expect(change.lane).toBeGreaterThanOrEqual(1);

    const failing = await scenario();
    const p2 = new FakePreviews();
    failing.ports.previews = p2;
    failing.ports.ci.outcome = () => ({ status: "failed", evidence: [] });
    const red = await startAndPush(failing);
    expect(p2.starts).toHaveLength(0);
    const ev = await failing.ports.store.getEvidence(red.change.id, red.headSha);
    expect(ev?.items.find((i) => i.kind === "preview")?.status).toBe("skipped");
  });

  it("screenshot failures are recorded as an error item, not a failed workflow", async () => {
    const s = await scenario();
    const previews = new FakePreviews();
    previews.screenshotError = new Error("browser quota");
    s.ports.previews = previews;
    const { change, headSha } = await startAndPush(s);
    const evidence = await s.ports.store.getEvidence(change.id, headSha);
    expect(evidence?.items.find((i) => i.kind === "screenshots")).toMatchObject({
      status: "error",
      note: expect.stringContaining("browser quota"),
    });
    expect((await reload(s, change.id)).status).toBe("awaiting-review");
  });
});

describe("bootstrap: time-to-first-green", () => {
  const provider: InitialCommitProvider = async () => ({
    files: { "README.md": "# x\n" },
    message: "init",
  });

  it("reports evidence + preview to the onboarding sink before the screenshots", async () => {
    const s = await scenario({ env: { coordinator: { initialCommit: provider } } });
    const previews = new FakePreviews();
    const onboarding = new FakeOnboarding();
    s.ports.previews = previews;
    s.ports.onboarding = onboarding;
    const human = s.ports.store.addPrincipal(principal({ kind: "human" }));
    const repo = await s.coordinator.createRepo(human, { name: "ttfg", template: "workers-api" });
    const change = await s.coordinator.startBootstrapChange(human, repo.id);
    await s.settle();
    expect(onboarding.events).toEqual([
      {
        repoId: repo.id,
        changeId: change.id,
        ciStatus: "passed",
        evidenceAt: expect.any(String),
        preview: expect.objectContaining({ status: "ready" }),
      },
    ]);
    expect(previews.starts[0]).toMatchObject({ artifactsRepo: "ttfg", template: "workers-api" });
    const done = await reload(s, change.id);
    expect(done.status).toBe("released");
    const evidence = await s.ports.store.getEvidence(change.id, change.baseSha);
    expect(evidence?.items.map((i) => i.kind)).toEqual(
      expect.arrayContaining(["preview", "screenshots"]),
    );
  });
});
