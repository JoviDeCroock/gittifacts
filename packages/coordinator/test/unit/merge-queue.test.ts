/**
 * The merge-queue algorithm, driven tick by tick (no workflows): a fake GitHost plays Artifacts,
 * the fake sandbox rebases at file level, the fake CI answers the cheap re-check instantly.
 */
import type { Change } from "@app/domain";
import { describe, expect, it } from "vitest";
import {
  createFakeEnvironment,
  type FakeWorkflowInstance,
  portsForRole,
} from "../../src/fakes/index.js";
import { changeWorkflowId, forkNameFor, REBASE_BRANCH, ZERO_SHA } from "../../src/ids.js";
import { MemoryQueueStorage, MergeQueueCore } from "../../src/merge-queue.js";

async function setup() {
  const env = createFakeEnvironment({ runWorkflows: false });
  const repo = await env.seedRepo({ files: { "src/a.ts": "a\n", "src/b.ts": "b\n" } });
  const storage = new MemoryQueueStorage();
  const queue = new MergeQueueCore({
    ports: portsForRole(env.ports, "merge-queue"),
    bindings: env.bindings,
    storage,
    options: { pollMs: 0 },
  });
  let n = 0;

  /** A change approved at its current head, with signed evidence, as the workflow leaves it. */
  async function approved(changes: Record<string, string | null>): Promise<Change> {
    const id = `c${++n}`;
    const forkName = forkNameFor(id);
    const baseSha = env.ports.git.head(repo.artifactsName) ?? "";
    await env.ports.git.forkRepo(repo.artifactsName, forkName);
    const headSha = env.ports.git.commit(forkName, "main", changes, `change ${id}`);
    const change: Change = {
      id,
      repoId: repo.id,
      planId: null,
      title: `change ${id}`,
      claim: { category: "fix", summary: null },
      baseSha,
      headSha,
      forkName,
      authorId: "agent",
      status: "queued",
      computedLane: 1,
      lane: 1,
      laneReasons: [],
      evidenceId: null,
      tourId: null,
      flagKey: null,
      mergedSha: null,
      rolloutState: null,
      revertOf: null,
      revertedBy: null,
      agentTraceId: null,
      createdAt: "2026-10-01T12:00:00.000Z",
      updatedAt: "2026-10-01T12:00:00.000Z",
    };
    await env.ports.store.insertChange(change);
    const signed = await env.ports.signer.signEvidence({ changeId: id, headSha, items: [] });
    await env.ports.store.putEvidence({
      ...signed,
      id: `ev-${id}`,
      baseSha,
      createdAt: change.createdAt,
      notesWritten: true,
    });
    // The workflow instance that waits for "merged".
    await env.bindings.changeWorkflow.create({
      id: changeWorkflowId(id, headSha),
      params: { changeId: id, headSha },
    });
    return change;
  }

  async function enqueue(c: Change) {
    return queue.enqueue({
      repoId: repo.id,
      changeId: c.id,
      headSha: c.headSha ?? "",
      workflowInstanceId: changeWorkflowId(c.id, c.headSha ?? ""),
    });
  }

  async function drain(max = 50): Promise<string[]> {
    const did: string[] = [];
    for (let i = 0; i < max; i++) {
      const r = await queue.tick();
      did.push(r.did);
      if (r.next === null) break;
      await new Promise((res) => setTimeout(res, 0));
    }
    return did;
  }

  const instanceOf = (c: Change) =>
    env.bindings.changeWorkflow.instances.get(
      changeWorkflowId(c.id, c.headSha ?? ""),
    ) as FakeWorkflowInstance;
  return {
    env,
    repo,
    queue,
    storage,
    approved,
    enqueue,
    drain,
    instanceOf,
    main: () => env.ports.git.head(repo.artifactsName),
  };
}

describe("MergeQueue", () => {
  it("fast-forwards main when it has not moved, then finalizes", async () => {
    const t = await setup();
    const c = await t.approved({ "src/a.ts": "a2\n" });
    expect(await t.enqueue(c)).toEqual({ position: 0 });
    expect(await t.drain()).toEqual(["merged", "idle"]);

    expect(t.main()).toBe(c.headSha);
    const git = t.env.ports.git;
    expect(git.repo(t.repo.artifactsName).refs.has(`refs/merge-queue/${c.id}`)).toBe(false); // staging ref deleted
    expect(await git.readNote(t.repo.artifactsName, c.headSha ?? "")).toContain(c.headSha); // evidence note copied
    expect(await t.env.ports.store.getChange(c.id)).toMatchObject({
      status: "merged",
      mergedSha: c.headSha,
    });
    expect(t.instanceOf(c).received).toEqual([
      { type: "merged", payload: { mergedSha: c.headSha, rebasedFrom: null, bundleRef: null } },
    ]);
    expect(t.env.bindings.alarms.map((a) => a.changeId)).toContain(c.id); // fork GC scheduled
    expect(t.env.ports.audit.actions(`change:${c.id}`)).toEqual([
      "merge-queue.enqueued",
      "change.merged",
    ]);
    // Order of main-repo writes: transfer into a staging ref, CAS the branch, note, delete staging.
    expect(git.writes.filter((w) => w.repo === t.repo.artifactsName).map((w) => w.op)).toEqual([
      "transfer",
      "update-ref",
      "note",
      "update-ref",
    ]);
  });

  it("is FIFO: one change at a time", async () => {
    const t = await setup();
    const a = await t.approved({ "src/a.ts": "a2\n" });
    const b = await t.approved({ "src/b.ts": "b2\n" });
    await t.enqueue(a);
    expect(await t.enqueue(b)).toEqual({ position: 1 });
    expect((await t.queue.list(t.repo.id)).map((e) => e.changeId)).toEqual([a.id, b.id]);
    await t.drain();
    const mergedA = await t.env.ports.store.getChange(a.id);
    const mergedB = await t.env.ports.store.getChange(b.id);
    expect(mergedA?.mergedSha).toBe(a.headSha);
    // b's base moved under it (a merged first), so it was rebased onto a.
    expect(mergedB?.status).toBe("merged");
    expect(t.env.ports.git.commits.get(mergedB?.mergedSha ?? "")?.parents).toEqual([a.headSha]);
    expect(t.env.ports.git.filesAt(t.main() ?? "")).toMatchObject({
      "src/a.ts": "a2\n",
      "src/b.ts": "b2\n",
    });
  });

  it("rebase path: rebases in the sandbox, re-runs cheap checks, re-signs evidence with rebasedFrom", async () => {
    const t = await setup();
    const c = await t.approved({ "src/a.ts": "a2\n" });
    const moved = t.env.ports.git.commit(
      t.repo.artifactsName,
      "main",
      { "src/b.ts": "b-main\n" },
      "someone else's merge",
    );
    await t.enqueue(c);
    const did = await t.drain();
    expect(did).toContain("rebased");

    const rebase = t.env.ports.sandbox.calls.find((x) => x.op === "rebase");
    expect(rebase?.input).toMatchObject({
      fork: c.forkName,
      headSha: c.headSha,
      ontoSha: moved,
      branch: REBASE_BRANCH,
    });
    const check = t.env.ports.ci.starts.find((r) => r.runId.startsWith("mq-"));
    expect(check).toMatchObject({
      evidenceSteps: [],
      pipelineFrom: "base",
      baseSha: moved,
      artifactsRepo: c.forkName,
    });

    const merged = await t.env.ports.store.getChange(c.id);
    expect(merged?.mergedSha).not.toBe(c.headSha);
    expect(t.main()).toBe(merged?.mergedSha);
    expect(t.env.ports.git.commits.get(merged?.mergedSha ?? "")?.parents).toEqual([moved]);
    expect(await t.env.ports.store.getEvidence(c.id, merged?.mergedSha ?? "")).toMatchObject({
      baseSha: moved,
    });
    expect(t.env.ports.signer.documents).toContainEqual(
      expect.objectContaining({
        purpose: "evidence-rebase",
        rebasedFrom: c.headSha,
        headSha: merged?.mergedSha,
        onto: moved,
      }),
    );
    expect(t.instanceOf(c).received[0]).toEqual({
      type: "merged",
      payload: { mergedSha: merged?.mergedSha, rebasedFrom: c.headSha, bundleRef: null },
    });
  });

  it("conflict: the change fails, the workflow hears merge-conflict, the queue moves on", async () => {
    const t = await setup();
    const c = await t.approved({ "src/a.ts": "mine\n" });
    t.env.ports.git.commit(t.repo.artifactsName, "main", { "src/a.ts": "theirs\n" });
    const before = t.main();
    await t.enqueue(c);
    expect(await t.drain()).toEqual(["failed:conflict", "idle"]);
    expect(t.main()).toBe(before);
    expect((await t.env.ports.store.getChange(c.id))?.status).toBe("failing");
    expect(t.instanceOf(c).received).toEqual([
      {
        type: "merge-conflict",
        payload: {
          reason: "conflict",
          detail: expect.stringContaining("conflicts"),
          files: ["src/a.ts"],
        },
      },
    ]);
    expect(t.env.ports.notifier.kinds(c.id)).toEqual(["failing"]);
    expect(await t.queue.list(t.repo.id)).toEqual([]);
  });

  it("stale CAS: retries from the top, bounded", async () => {
    const t = await setup();
    const c = await t.approved({ "src/a.ts": "a2\n" });
    let stale = 2;
    t.env.ports.git.updateRefHook = (_repo, ref) =>
      ref === "refs/heads/main" && stale-- > 0
        ? { ok: false, reason: "stale", detail: "ng refs/heads/main stale ref" }
        : undefined;
    await t.enqueue(c);
    expect(await t.drain()).toEqual(["stale", "stale", "merged", "idle"]);
    expect(t.main()).toBe(c.headSha);

    const t2 = await setup();
    const d = await t2.approved({ "src/a.ts": "a3\n" });
    t2.env.ports.git.updateRefHook = (_repo, ref) =>
      ref === "refs/heads/main" ? { ok: false, reason: "stale", detail: "racing" } : undefined;
    await t2.enqueue(d);
    const did = await t2.drain();
    expect(did.filter((x) => x === "stale")).toHaveLength(5);
    expect(did).toContain("failed:stale-exhausted");
    expect(t2.instanceOf(d).received[0]?.type).toBe("merge-conflict");
  });

  it("cheap checks failing after a rebase fail the change", async () => {
    const t = await setup();
    const c = await t.approved({ "src/a.ts": "a2\n" });
    t.env.ports.git.commit(t.repo.artifactsName, "main", { "src/b.ts": "b-main\n" });
    t.env.ports.ci.outcome = () => ({ status: "failed", evidence: [] });
    await t.enqueue(c);
    expect(await t.drain()).toContain("failed:checks-failed");
    expect((await t.env.ports.store.getChange(c.id))?.status).toBe("failing");
  });

  it("drops items whose change was abandoned or re-pushed", async () => {
    const t = await setup();
    const c = await t.approved({ "src/a.ts": "a2\n" });
    await t.enqueue(c);
    await t.env.ports.store.updateChange(c.id, { status: "abandoned" });
    expect(await t.drain()).toEqual(["dropped", "idle"]);
    expect(t.main()).not.toBe(c.headSha);
    expect(await t.queue.remove({ repoId: t.repo.id, changeId: c.id })).toBe(false);
  });

  it("transient errors back off and eventually fail the item", async () => {
    const t = await setup();
    const c = await t.approved({ "src/a.ts": "a2\n" });
    t.env.ports.git.updateRefHook = () => {
      throw new Error("artifacts 503");
    };
    await t.enqueue(c);
    const first = await t.queue.tick();
    expect(first).toEqual({ next: 30_000, did: "error" });
    expect((await t.queue.list(t.repo.id))[0]?.lastError).toBe("artifacts 503");
    const did = await t.drain();
    expect(did).toContain("failed:error");
  });

  it("recovers when main was already fast-forwarded before a crash", async () => {
    const t = await setup();
    const c = await t.approved({ "src/a.ts": "a2\n" });
    await t.enqueue(c);
    // Simulate: a previous tick transferred + fast-forwarded, then the DO restarted.
    await t.env.ports.git.transferObjects(
      c.forkName,
      t.repo.artifactsName,
      c.headSha ?? "",
      `refs/merge-queue/${c.id}`,
    );
    await t.env.ports.git.updateRef(
      t.repo.artifactsName,
      "refs/heads/main",
      c.baseSha,
      c.headSha ?? "",
    );
    expect(await t.drain()).toEqual(["merged", "idle"]);
    expect(await t.env.ports.store.getChange(c.id)).toMatchObject({
      status: "merged",
      mergedSha: c.headSha,
    });
  });

  it("only the merge-queue role may write main; every other role writes forks only", async () => {
    const t = await setup();
    const c = await t.approved({ "src/a.ts": "a2\n" });
    const fork = portsForRole(t.env.ports, "default").git;
    expect(() =>
      fork.updateRef(t.repo.artifactsName, "refs/heads/main", c.baseSha, c.headSha ?? ""),
    ).toThrow(/forbidden/);
    expect(() => fork.mintToken(t.repo.artifactsName, "write", 60)).toThrow(/forbidden/);
    expect(() =>
      fork.transferObjects(c.forkName, t.repo.artifactsName, c.headSha ?? "", "refs/x"),
    ).toThrow(/forbidden/);
    await expect(fork.writeNote(c.forkName, c.headSha ?? "", "ok")).resolves.toBeUndefined();
    // Main-repo write tokens are capped at five minutes even for the queue.
    const { token } = await t.env.ports.git.mintToken(t.repo.artifactsName, "write", 3600);
    expect(t.env.ports.git.tokens.find((x) => x.token === token)?.ttlSeconds).toBe(300);
    expect(ZERO_SHA).toHaveLength(40);
  });
});
