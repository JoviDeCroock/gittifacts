/**
 * M4 through the agent-native queue's deploy trains (the platform default), over fakes: a merged
 * Change that guards its new code with its own flag deploys alone (train), regresses, and the
 * shell switches its flag off, rolls the Worker back and opens the revert Change, with no human.
 */
import type { ChangeDiff } from "@app/domain";
import { describe, expect, it } from "vitest";
import { revertIdFor } from "../../src/ids.js";
import { watchMsFor } from "../../src/queue/trains.js";
import { queueEnv } from "./queue-harness.js";

const fast = {
  stages: [50, 100],
  stageMinutes: 2,
  watchMinutes: 3,
  maxErrorRateIncrease: 0.05,
  maxNewIssueGroups: 0,
  minRequests: 20,
};
const SCRIPT = "gf-app-api";

function diffOf(baseSha: string, headSha: string, added: string[]): ChangeDiff {
  return {
    baseSha,
    headSha,
    additions: added.length,
    deletions: 0,
    files: [
      {
        path: "src/app.ts",
        status: "modified",
        additions: added.length,
        deletions: 0,
        transformVerified: false,
        truncated: false,
        hunks: [
          {
            header: "@@ -1 +1 @@",
            oldStart: 1,
            oldLines: 0,
            newStart: 1,
            newLines: added.length,
            lines: added.map((text, i) => ({ kind: "add", oldNo: null, newNo: i + 1, text })),
          },
        ],
      },
    ],
  } as unknown as ChangeDiff;
}

async function trainEnv() {
  const env = await queueEnv({ trains: true });
  const { store, deployer, ci } = env.ports;
  await store.updateRepo(env.repo.id, {
    deployTarget: SCRIPT,
    policy: { ...env.repo.policy, rollout: fast },
  });
  deployer.live.set(SCRIPT, [{ versionId: "v0", percentage: 100 }]);
  // Batch runs report the build step's bundle, like the engine's RunStatus.artifacts.
  const status = ci.status.bind(ci);
  ci.status = async (runId) =>
    ({
      ...(await status(runId)),
      artifacts: {
        bundle: { key: `ci-artifacts/${runId}/build/bundle.tgz`, step: "build" },
      },
    }) as Awaited<ReturnType<typeof status>>;
  return env;
}

/** Alarm rounds with the clock moving (the DO alarm fires every 30 s while trains are live). */
async function tick(env: Awaited<ReturnType<typeof trainEnv>>, rounds: number) {
  const svc = env.queue();
  for (let i = 0; i < rounds; i++) {
    env.ports.clock.advance(30_000);
    await svc.alarm();
    await env.settle();
    await svc.loop.settle();
  }
}

describe("M4 through deploy trains", () => {
  it("a regressing single-change train: flag off, rollback to the previous version, revert Change", async () => {
    const env = await trainEnv();
    const { store, deployer, flags, telemetry, audit } = env.ports;
    const c1 = await env.change("c1", { "src/app.ts": "throw sometimes\n" }, 1);
    await store.putDiff(
      "c1",
      diffOf(c1.baseSha, c1.headSha ?? "", ['if (await isChangeEnabled(env, "c1")) maybeThrow();']),
    );
    await env.admit(c1);
    await env.drive();

    // Deployed as its own train at the first stage, with its flag on.
    expect(deployer.uploads.map((u) => u.changeId)).toEqual(["c1"]);
    const versionId = deployer.uploads[0]?.versionId ?? "";
    expect(deployer.live.get(SCRIPT)).toEqual([
      { versionId, percentage: 50 },
      { versionId: "v0", percentage: 50 },
    ]);
    expect(flags.flags.get("change-c1")).toBe(true);
    const rolling = await store.getChange("c1");
    expect(rolling?.status).toBe("rolling-out");
    expect(rolling?.rolloutState).toMatchObject({ versionId, previousVersionId: "v0" });

    // 40% of the new version's requests throw; the next alarm samples it.
    const healthy = telemetry.fallback;
    telemetry.fallback = { ...healthy, requests: 200, errorRate: 0.4, baselineErrorRate: 0 };
    await tick(env, 1);
    telemetry.fallback = healthy; // v0 is back at 100%: healthy again

    expect(flags.history).toContainEqual({ key: "change-c1", enabled: false });
    expect(deployer.rollbacks).toEqual([
      expect.objectContaining({ script: SCRIPT, versionId: "v0" }),
    ]);
    const reverted = await store.getChange("c1");
    expect(reverted?.status).toBe("reverted");
    expect(reverted?.revertedBy).toBe(revertIdFor("c1"));
    expect(reverted?.rolloutState?.status).toBe("rolled-back");
    expect(audit.actions()).toEqual(
      expect.arrayContaining(["deploy.flag-off", "deploy.regression-attributed"]),
    );

    // The revert is an automatic, verified pure revert: it lands and deploys like any Change.
    await tick(env, 4);
    const revert = await store.getChange(revertIdFor("c1"));
    expect(revert).toMatchObject({ revertOf: "c1", authorId: "system" });
    expect(revert?.mergedSha).not.toBeNull();
    expect(deployer.uploads.map((u) => u.changeId)).toEqual(["c1", revertIdFor("c1")]);
    expect(deployer.rollbacks).toHaveLength(1);
  });

  it("never reverts a revert: a regressing revert is rolled back and left to a human", async () => {
    const env = await trainEnv();
    const { store, deployer, telemetry, audit, notifier } = env.ports;
    const c1 = await env.change("c1", { "src/b.ts": "export const b = 1;\n" }, 1);
    await env.admit(c1);
    await env.drive();
    await tick(env, 16); // released
    const healthy = telemetry.fallback;
    telemetry.fallback = { ...healthy, requests: 200, errorRate: 0.4, baselineErrorRate: 0 };
    // A human kill-switch style revert of c1, merged and deployed while the error is environmental.
    const rv = await env.change("rv-c1", { "src/b.ts": null }, 1);
    await store.updateChange("rv-c1", {
      revertOf: "c1",
      claim: { category: "revert", summary: "x" },
    });
    await env.admit({ ...rv, revertOf: "c1" });
    await env.drive();
    await tick(env, 2);
    expect(deployer.rollbacks).toHaveLength(1);
    expect(await store.getChange(revertIdFor("rv-c1"))).toBeNull();
    expect(audit.actions()).toContain("deploy.revert-skipped");
    expect((await store.getChange("rv-c1"))?.status).toBe("merged");
    expect(
      notifier.sent.some((n) => n.kind === "regression-detected" && n.changeId === "rv-c1"),
    ).toBe(true);
  });

  it("holds the Worker for the deploy-time policy's stages + watch, then releases", async () => {
    expect(watchMsFor(fast, [50, 100])).toBe((2 * 2 + 3) * 60_000);
    expect(watchMsFor({ ...fast, watchMinutes: 1, stageMinutes: 1 }, [100])).toBe(2 * 60_000);
    const env = await trainEnv();
    const c1 = await env.change("c1", { "src/b.ts": "export const b = 1;\n" }, 1);
    await env.admit(c1);
    await env.drive();
    await tick(env, 13); // 6.5 minutes: stage 2 reached, still watching
    expect((await env.ports.store.getChange("c1"))?.status).toBe("rolling-out");
    expect(env.ports.deployer.live.get(SCRIPT)?.[0]?.percentage).toBe(100);
    await tick(env, 2);
    expect((await env.ports.store.getChange("c1"))?.status).toBe("released");
  });
});
