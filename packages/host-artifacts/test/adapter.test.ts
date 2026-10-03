import { HostError, type LaneVerdict } from "@app/host";
import { CONTRACT_SCENARIOS, contractReviewer, loadFixture } from "@app/host-contract";
import { describe, expect, it } from "vitest";
import { NativeContractHost } from "./native-host.js";

const ARTIFACTS_PUSH = "cf.artifacts.repo.pushed";

async function graded() {
  const host = new NativeContractHost(contractReviewer());
  const s = CONTRACT_SCENARIOS["pure-bugfix-with-regression-test"]();
  const fx = loadFixture(s.fixture);
  const { ref, headSha } = await host.open({
    scenario: s,
    base: fx.base,
    push: fx.push,
    title: fx.title,
  });
  await host.settle();
  return { host, ref, headSha, fx };
}

function pushEvent(repoName: string, before: string, after: string, ref = "refs/heads/main") {
  return { type: ARTIFACTS_PUSH, source: { repoName }, payload: { ref, before, after } };
}

describe("ArtifactsHost", () => {
  it("describes a native change in host terms", async () => {
    const { host, ref, headSha } = await graded();
    const meta = await host.adapter.getChange(ref);
    expect(meta).toMatchObject({
      ref,
      headSha,
      category: "fix",
      author: { kind: "agent" },
      source: { fork: true },
      state: "open",
      baseBranch: "main",
    });
    expect(meta.planRefs).toHaveLength(1);
    await expect(
      host.adapter.getChange({ host: "github", owner: "o", repo: "r", number: 1 }),
    ).rejects.toBeInstanceOf(HostError);
  });

  it("materializes a head read-only, and only heads the fork has", async () => {
    const { host, ref, headSha } = await graded();
    const checkout = await host.adapter.materialize(ref, headSha);
    expect(checkout).toMatchObject({ sha: headSha, writable: false, token: { scope: "read" } });
    expect(checkout.artifactsRepo.startsWith("task-")).toBe(true);
    await expect(host.adapter.materialize(ref, "f".repeat(40))).rejects.toThrow(/not in/);
  });

  it("drops a verdict for a head the change no longer has", async () => {
    const { host, ref, headSha } = await graded();
    const before = await host.observe(ref, headSha);
    const stale = { ...before.verdict, headSha: "e".repeat(40) } as unknown as LaneVerdict;
    await host.adapter.publishVerdict(ref, stale);
    expect((await host.observe(ref, "e".repeat(40))).verdict).toBeNull();
  });

  it("merges only an approved or Lane 0 head, through the platform's queue", async () => {
    const { host, ref, headSha } = await graded();
    const { store, git } = host.env.ports;
    expect(
      await host.adapter.merge(ref, { expectedHeadSha: headSha, method: "fast-forward" }),
    ).toMatchObject({
      status: "refused",
      reason: "not-allowed",
    });
    if (ref.host !== "artifacts") throw new Error("native ref");
    await store.updateChange(ref.changeId, { status: "approved" });
    const out = await host.adapter.merge(ref, { expectedHeadSha: headSha, method: "fast-forward" });
    expect(out.status).toBe("queued");
    await host.settle();
    const repo = await store.getRepo(ref.repoId);
    expect(git.head(repo?.artifactsName ?? "")).toBe(headSha);
  });

  it("normalizes Artifacts pushes into change.updated / main.advanced", async () => {
    const { host, ref, headSha, fx } = await graded();
    const { store } = host.env.ports;
    if (ref.host !== "artifacts") throw new Error("native ref");
    const change = await store.getChange(ref.changeId);
    const repo = await store.getRepo(ref.repoId);
    if (change === null || repo === null) throw new Error("missing rows");
    const events = host.adapter.events();
    const next = await host.push(
      ref,
      { "test/allocate.test.ts": `${fx.head["test/allocate.test.ts"]}// more\n` },
      { force: false },
    );
    expect(await events.normalize(pushEvent(change.forkName, headSha, next))).toEqual([
      { type: "change.updated", ref, headSha: next, previousHeadSha: headSha, forced: false },
    ]);
    const forced = await host.push(ref, fx.push, { force: true });
    const [ev] = await events.normalize(pushEvent(change.forkName, next, forced));
    expect(ev).toMatchObject({ type: "change.updated", forced: true });
    expect(await events.normalize(pushEvent(repo.artifactsName, change.baseSha, forced))).toEqual([
      {
        type: "main.advanced",
        repo: { host: "artifacts", repoId: repo.id },
        branch: "main",
        before: change.baseSha,
        after: forced,
      },
    ]);
    expect(await events.normalize({ type: "something.else" })).toEqual([]);
    expect(
      await events.normalize(pushEvent(change.forkName, headSha, next, "refs/tags/v1")),
    ).toEqual([]);
  });
});
