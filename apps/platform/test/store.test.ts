import { env } from "cloudflare:workers";
import { shadowAgreement } from "@app/classifier";
import { describe, expect, it } from "vitest";
import { platformSigner } from "../src/signing.js";
import { INLINE_JSON_LIMIT } from "../src/store/d1-store.js";
import { StoreDataError } from "../src/store/rows.js";
import {
  BASE_SHA,
  changeFixture,
  classificationFixture,
  diffFixture,
  evidenceFixture,
  HEAD_SHA,
  repoFixture,
  runFixture,
  seedWorld,
  store,
  tourFixture,
  uid,
} from "./fixtures.js";

describe("D1Store", () => {
  it("round-trips repos, including lookups and policy updates", async () => {
    const s = store();
    const repo = repoFixture();
    await s.insertRepo(repo);
    expect(await s.getRepo(repo.id)).toEqual(repo);
    expect(await s.getRepoByArtifactsName(repo.artifactsName)).toEqual(repo);
    const policy = { ...repo.policy, lane0Enabled: true };
    await s.setRepoPolicy(repo.id, policy, HEAD_SHA);
    expect(await s.getRepo(repo.id)).toMatchObject({
      policySha: HEAD_SHA,
      policy: { lane0Enabled: true },
    });
    const updated = await s.updateRepo(repo.id, { deployTarget: "my-worker" });
    expect(updated.deployTarget).toBe("my-worker");
    expect(await s.getRepo("nope")).toBeNull();
  });

  it("round-trips changes and shallow-merges updates", async () => {
    const { s, change, agent } = await seedWorld();
    expect(await s.getChange(change.id)).toEqual(change);
    expect(await s.getChangeByFork(change.forkName)).toEqual(change);
    const next = await s.updateChange(change.id, {
      status: "rolling-out",
      rolloutState: {
        status: "rolling",
        versionId: "ver-123",
        previousVersionId: "ver-100",
        stages: [{ percent: 5, startedAt: new Date().toISOString(), completedAt: null }],
        watchUntil: null,
        flagKey: "change-x",
        lastCheck: null,
      },
    });
    expect(next.status).toBe("rolling-out");
    expect(next.authorId).toBe(agent);
    expect(next.updatedAt >= change.updatedAt).toBe(true);
    expect((await s.getChangeByRolloutVersion("ver-123"))?.id).toBe(change.id);
    expect((await s.listChanges(change.repoId, ["rolling-out"])).map((c) => c.id)).toEqual([
      change.id,
    ]);
    expect(await s.listChanges(change.repoId, ["merged"])).toEqual([]);
  });

  it("stores runs, classifications and tours per head", async () => {
    const { s, change } = await seedWorld();
    const run = runFixture(change.id);
    await s.upsertRun(run);
    await s.upsertRun({ ...run, status: "failed" });
    expect((await s.getRun(run.id))?.status).toBe("failed");
    expect(await s.listRuns(change.id, HEAD_SHA)).toHaveLength(1);

    const cls = classificationFixture();
    await s.putClassification(change.id, HEAD_SHA, cls);
    expect(await s.getClassification(change.id, HEAD_SHA)).toEqual(cls);
    expect(await s.getClassification(change.id, BASE_SHA)).toBeNull();

    const tour = tourFixture(change.id);
    await s.putTour(tour);
    expect(await s.getTour(change.id, HEAD_SHA)).toEqual(tour);
  });

  it("keeps small diffs inline and spills large ones to R2", async () => {
    const { s, change } = await seedWorld();
    const small = diffFixture();
    await s.putDiff(change.id, small);
    expect(await s.getDiff(change.id, HEAD_SHA)).toEqual(small);

    const big = diffFixture({ headSha: "c".repeat(40) });
    const line = { kind: "add" as const, oldNo: null, newNo: 1, text: "x".repeat(1000) };
    big.files[0]!.hunks[0]!.lines = Array.from({ length: 700 }, () => line);
    await s.putDiff(change.id, big);
    const row = await env.DB.prepare(
      "SELECT json, r2_key, size_bytes FROM diffs WHERE change_id = ? AND head_sha = ?",
    )
      .bind(change.id, big.headSha)
      .first<{ json: string | null; r2_key: string | null; size_bytes: number }>();
    expect(row?.json).toBeNull();
    expect(row?.r2_key).toBe(`diffs/${change.id}/${big.headSha}.json`);
    expect(row!.size_bytes).toBeGreaterThan(INLINE_JSON_LIMIT);
    expect(await env.BLOBS.head(row!.r2_key!)).not.toBeNull();
    expect(await s.getDiff(change.id, big.headSha)).toEqual(big);
  });

  it("stores signed evidence that still verifies after the round trip", async () => {
    const { s, change } = await seedWorld();
    const ev = await evidenceFixture(change.id);
    await s.putEvidence(ev);
    const back = await s.getEvidence(change.id, HEAD_SHA);
    expect(back).toEqual(ev);
    const signer = await platformSigner(env);
    expect(await signer.verifyEvidence(back!)).toEqual({ ok: true });
  });

  it("fails loudly on a row that no longer matches the domain schema", async () => {
    const { s, change } = await seedWorld();
    await env.DB.prepare("UPDATE changes SET status = 'exploded' WHERE id = ?")
      .bind(change.id)
      .run();
    await expect(s.getChange(change.id)).rejects.toBeInstanceOf(StoreDataError);
  });

  it("derives shadow samples from human reviews of computed lane-0 changes", async () => {
    const { s, repo, human, agent } = await seedWorld();
    for (const [i, decision] of (["approve", "approve", "request-changes"] as const).entries()) {
      const c = changeFixture(repo.id, agent, { computedLane: 0, lane: 1 });
      await s.insertChange(c);
      await s.putReview({
        id: uid("rev"),
        changeId: c.id,
        headSha: HEAD_SHA,
        reviewerId: human,
        decision,
        humanLane: i === 1 ? 1 : null,
        computedLane: 0,
        comment: null,
        createdAt: new Date().toISOString(),
      });
    }
    const samples = await s.listShadowSamples(repo.id);
    expect(samples).toHaveLength(3);
    const agreement = shadowAgreement(samples, repo.policy);
    expect(agreement).toMatchObject({ samples: 3, agreed: 1, eligibleToEnableLane0: false });
    expect((await s.listShadowSamplesByRepo()).get(repo.id)).toHaveLength(3);
  });

  it("upserts issues and filters by version, change and time", async () => {
    const { s, change } = await seedWorld();
    const base = {
      id: uid("iss"),
      changeId: change.id,
      title: "TypeError: x is undefined",
      count: 3,
      firstSeen: "2026-10-01T10:00:00.000Z",
      lastSeen: "2026-10-01T10:05:00.000Z",
      versionId: "ver-9",
      url: null,
      scriptName: "app",
      raw: { any: "thing" },
    };
    await s.putIssue(base);
    await s.putIssue({
      ...base,
      count: 7,
      firstSeen: "2026-10-01T10:02:00.000Z",
      lastSeen: "2026-10-01T10:09:00.000Z",
    });
    const [issue] = await s.listIssues({ changeId: change.id });
    expect(issue).toMatchObject({
      count: 7,
      firstSeen: base.firstSeen,
      lastSeen: "2026-10-01T10:09:00.000Z",
    });
    expect(await s.listIssues({ versionId: "ver-9" })).toHaveLength(1);
    expect(
      await s.listIssues({ since: "2026-10-02T00:00:00.000Z", changeId: change.id }),
    ).toHaveLength(0);
  });

  it("summarises changes with plan title and author, and counts lanes", async () => {
    const { s, repo, agent, change, plan } = await seedWorld();
    await s.insertChange(
      changeFixture(repo.id, agent, { status: "failing", lane: 2, computedLane: 2 }),
    );
    await s.insertChange(
      changeFixture(repo.id, agent, { status: "merged", lane: 0, computedLane: 0 }),
    );
    const all = await s.listChangeSummaries(repo.id);
    expect(all).toHaveLength(3);
    const mine = all.find((c) => c.id === change.id)!;
    expect(mine).toMatchObject({
      planTitle: plan.title,
      authorName: "builder-bot",
      authorKind: "agent",
    });
    expect(await s.listChangeSummaries(repo.id, { lane: 2 })).toHaveLength(1);
    expect(await s.listChangeSummaries(repo.id, { statuses: ["merged", "failing"] })).toHaveLength(
      2,
    );
    const counts = (await s.laneCounts(repo.id)).get(repo.id);
    expect(counts).toEqual({
      lane0: 0,
      lane1: 1,
      lane2: 1,
      awaitingReview: 1,
      rollingOut: 0,
      failing: 1,
      plansAwaitingApproval: 0,
    });
    expect((await s.countDraftPlans(repo.id)).get(repo.id)).toBe(1);
  });
});
