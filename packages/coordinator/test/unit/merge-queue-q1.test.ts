/**
 * Merge queue Q1 acceptance (docs/prompts/03-merge-queue.md §7) through the real shell, store,
 * loop, handlers, BatchRunWorkflow body and pure core, over fakes: CAS on main (a stale old-oid
 * is rejected and the queue retries), speculative batches on one track, bisection ejecting only
 * the culprit, main never red, refs/queue GC.
 */

import type { ResolverInput } from "@app/resolver";
import { describe, expect, it } from "vitest";
import { push, reload, scenario } from "./helpers.js";
import { attachAgentQueue, type QueueEnv, queueEnv } from "./queue-harness.js";

/** Every tree main ever pointed at (after genesis) passed a full CI run on exactly that tree. */
function assertMainNeverRed(env: QueueEnv): void {
  const { git, ci } = env.ports;
  const tested = new Map<string, string>();
  for (const run of ci.runs.values())
    if (run.status.status === "passed")
      tested.set(git.commits.get(run.request.headSha)?.tree ?? "", run.request.headSha);
  for (const sha of env.mainHistory.slice(1)) {
    const tree = git.commits.get(sha)?.tree ?? "";
    expect(git.filesAt(sha)["src/bad.ts"], `main at ${sha.slice(0, 8)} is red`).toBeUndefined();
    expect(tested.has(tree), `main at ${sha.slice(0, 8)} was never tested`).toBe(true);
  }
}

function queueRefs(env: QueueEnv): string[] {
  return [...env.ports.git.repo("app").refs.keys()].filter((r) => r.startsWith("refs/queue/"));
}

describe("merge queue Q1 (shell + core over fakes)", () => {
  it("lands a lone Change with CAS, re-signs its evidence for what landed, and GCs refs/queue", async () => {
    const env = await queueEnv();
    const c1 = await env.change("c1", { "src/b.ts": "export const b = 1;\n" });
    await env.admit(c1);
    await env.drive();

    const main = env.ports.git.head("app");
    expect(main).toBe(c1.headSha); // fast path: the head is the batch commit
    const row = await env.ports.store.getChange("c1");
    expect(row?.status).toBe("merged");
    expect(row?.mergedSha).toBe(main);
    expect(await env.ports.store.getEvidence("c1", main ?? "")).not.toBeNull();
    expect(env.ports.audit.actions()).toContain("merge-queue.merge-evidence");
    const events = env
      .queue()
      .store.eventsSince(0, 100)
      .map((e) => e.type);
    expect(events).toEqual(expect.arrayContaining(["entered_batch", "merged"]));
    expect(queueRefs(env)).toEqual([]);
    assertMainNeverRed(env);
  });

  it("rejects a CAS with a stale old-oid and retries on the new main", async () => {
    const env = await queueEnv();
    const { git } = env.ports;
    const c1 = await env.change("c1", { "src/b.ts": "export const b = 1;\n" });
    let moved = false;
    git.updateRefHook = (repo, ref) => {
      if (repo === "app" && ref === "refs/heads/main" && !moved) {
        moved = true; // someone else moved main right before our CAS
        git.commit("app", "main", { "docs/external.md": "outside the queue\n" }, "external");
      }
      return undefined; // the real compare-and-swap decides
    };
    await env.admit(c1);
    await env.drive();

    const { audit } = env.ports;
    const refused = audit.events.findIndex((e) => e.action === "merge-queue.cas-refused");
    expect(refused).toBeGreaterThanOrEqual(0);
    expect(audit.payloads[refused]).toMatchObject({ reason: "stale" });
    // The core saw main move under it and rebuilt the batch on the new main before landing.
    expect(audit.actions()).toEqual(
      expect.arrayContaining(["merge-queue.cas-stale", "merge-queue.main-moved-externally"]),
    );
    const files = git.filesAt(git.head("app") ?? "");
    expect(files["docs/external.md"]).toBeDefined(); // nothing lost
    expect(files["src/b.ts"]).toBe("export const b = 1;\n");
    expect((await env.ports.store.getChange("c1"))?.status).toBe("merged");
    expect(queueRefs(env)).toEqual([]);
    assertMainNeverRed(env);
  });

  it("speculates: batch N+1 runs on top of batch N before N finished, and all land in order", async () => {
    const env = await queueEnv({ config: { maxBatchSize: 1 } });
    const { ci, git } = env.ports;
    // One track: every Change reaches the same module.
    env.jobs.affectedOverride = ({ files }) => ({
      files,
      modules: ["src/shared.ts", ...files],
      testTargets: ["src/shared.test.ts"],
      publicApi: false,
      deploysTo: [],
      complete: true,
      analyzers: [],
    });
    ci.autoFinish = false;
    const changes = [];
    for (const id of ["c1", "c2", "c3"])
      changes.push(await env.change(id, { [`src/${id}.ts`]: `export const ${id} = 1;\n` }));
    for (const c of changes) await env.admit(c);
    const svc = env.queue();
    for (let i = 0; i < 20; i++) {
      await env.bindings.settle();
      await new Promise((r) => setTimeout(r, 1));
    }
    const running = [...ci.runs.values()].filter((r) => r.status.status === "running");
    expect(running).toHaveLength(3); // three speculative batches in flight at once
    const byHead = new Map(running.map((r) => [r.request.headSha, r.request]));
    // Each batch is tested on the tree it would land: c1, c1+c2, c1+c2+c3. With direct carrying
    // (the core's default) every batch is built on main and carries the entries it conflicts with,
    // so assert the tested trees' contents rather than how their bases chain.
    const trees = running
      .map((r) => {
        const files = git.filesAt(r.request.headSha);
        return ["c1", "c2", "c3"].filter((id) => files[`src/${id}.ts`] !== undefined).join("+");
      })
      .sort();
    expect(trees).toEqual(["c1", "c1+c2", "c1+c2+c3"]);
    expect(byHead.size).toBe(3);
    ci.autoFinish = true;
    for (const r of running) await ci.finish(r.request.runId);
    await env.drive();
    for (const id of ["c1", "c2", "c3"])
      expect((await env.ports.store.getChange(id))?.status).toBe("merged");
    // The landing pipeline may land several passed batches in one CAS; what matters is that main
    // advanced only to tested trees (assertMainNeverRed) and ends with all three Changes.
    expect(env.mainHistory.length).toBeGreaterThan(1);
    const finalFiles = git.filesAt(git.head("app"));
    for (const id of ["c1", "c2", "c3"]) expect(finalFiles[`src/${id}.ts`]).toBeDefined();
    expect(svc.loop.state.main.sha).toBe(git.head("app"));
    expect(queueRefs(env)).toEqual([]);
    assertMainNeverRed(env);
  });

  it("bisects a failed batch and ejects only the culprit (the rest re-forms and lands)", async () => {
    const env = await queueEnv({ resolver: () => null });
    env.jobs.affectedOverride = ({ files }) => ({
      files,
      modules: ["src/shared.ts", ...files],
      testTargets: ["src/shared.test.ts"],
      publicApi: false,
      deploysTo: [],
      complete: true,
      analyzers: [],
    });
    const ids = ["c1", "c2", "c3", "c4"];
    const changes = [];
    for (const id of ids)
      changes.push(
        await env.change(
          id,
          id === "c2"
            ? { "src/bad.ts": "throw new Error('boom');\n" }
            : { [`src/${id}.ts`]: "ok\n" },
        ),
      );
    for (const c of changes) await env.admit(c);
    await env.drive();

    const c2 = env.queue().loop.state.entries.c2;
    expect(c2?.state).toBe("ejected");
    expect(c2?.ejectReason?.code).toBe("tests-failed");
    expect(c2?.ejectReason?.fix.call).toBe('open_workspace({ changeId: "c2" })');
    expect((await env.ports.store.getChange("c2"))?.status).toBe("failing");
    for (const id of ["c1", "c3", "c4"])
      expect((await env.ports.store.getChange(id))?.status).toBe("merged");
    const main = env.ports.git.filesAt(env.ports.git.head("app") ?? "");
    expect(main["src/bad.ts"]).toBeUndefined();
    expect(main["src/c4.ts"]).toBe("ok\n");
    const types = env
      .queue()
      .store.eventsSince(0, 500)
      .map((e) => e.type);
    expect(types.filter((t) => t === "ejected")).toHaveLength(1);
    expect(queueRefs(env)).toEqual([]);
    assertMainNeverRed(env);
  });

  it("end to end with the ChangeWorkflow: a textual conflict is resolved by the resolver (not the author) and both Changes merge", async () => {
    const s = await scenario({
      policy: { lane0Enabled: true },
      name: "app",
      files: { "src/a.ts": "export const a = 1;\n", "README.md": "# app\n" },
    });
    const seen: ResolverInput[] = [];
    const env = attachAgentQueue(s, s.repo, {
      config: { maxBatchSize: 1 },
      resolver: (input) => {
        seen.push(input);
        return { "src/a.ts": "export const a = 12;\n" };
      },
    });
    const start = (title: string) =>
      s.coordinator.startChange(s.agent, {
        repoId: s.repo.id,
        planId: `plan-${s.repo.id}`,
        title,
        category: "fix",
      });
    const a = (await start("A")).change;
    const b = (await start("B")).change;
    const ha = push(s, a, { "src/a.ts": "export const a = 10;\n" });
    const hb = push(s, b, {
      "src/a.ts": "export const a = 2;\n",
      "src/b.ts": "export const b = 1;\n",
    });
    for (const [c, h] of [
      [a, ha],
      [b, hb],
    ] as const)
      await s.coordinator.onPush({
        repoName: c.forkName,
        ref: "refs/heads/main",
        before: c.baseSha,
        after: h,
      });
    await env.drive();
    await s.settle();

    // The resolver saw only id/title/SHAs and is never the author.
    expect(seen).toHaveLength(1);
    expect(Object.keys(seen[0]?.change ?? {}).sort()).toEqual([
      "baseSha",
      "headSha",
      "id",
      "title",
    ]);
    expect(seen[0]?.excludePrincipals).toContain(s.agent.id);
    const svc = env.queue();
    const eb = svc.loop.state.entries[b.id];
    expect(eb?.state).toBe("merged");
    expect(eb?.resolverIds).toEqual(["system:resolver"]);
    expect(eb?.lane).toBe(0); // within the hunks, no new lines: the lane stays
    const main = s.ports.git.filesAt(s.ports.git.head("app") ?? "");
    expect(main["src/a.ts"]).toBe("export const a = 12;\n");
    expect(main["src/b.ts"]).toBe("export const b = 1;\n"); // the Change's own clean edits survive
    const events = svc.store.eventsSince(0, 500);
    expect(events.find((e) => e.type === "resolving_conflict")?.data).toMatchObject({
      changeId: b.id,
      kind: "textual",
      upstream: [a.id],
    });
    expect(events.map((e) => e.type)).toContain("resolution_ready");
    const ev = await s.ports.store.getEvidence(b.id, eb?.headSha ?? "");
    expect(ev?.items.map((i) => i.kind)).toContain("conflict-resolution");
    // Both ChangeWorkflows saw "merged" and finished (no deploy target: released).
    for (const c of [a, b]) {
      const row = await reload(s, c.id);
      expect(row.status).toBe("released");
      expect(row.mergedSha).not.toBeNull();
    }
    expect(queueRefs(env)).toEqual([]);
    assertMainNeverRed(env);
  });

  it("answers enqueue before admission, refuses an agent's incident class, and wait_for_merge returns on merge", async () => {
    const env = await queueEnv();
    const svc = env.queue();
    const { QueueAgentApi } = await import("../../src/queue/agent-api.js");
    const api = new QueueAgentApi(svc);
    const c1 = await env.change("c1", { "src/b.ts": "b\n" });
    await env.ports.store.updateChange("c1", { status: "awaiting-review", lane: 1 });
    const agent = { principalId: "agent-c1", kind: "agent" as const, sessionId: "s1" };
    const early = await api.request({ changeId: "c1", priority: "security", by: agent });
    expect(early).toMatchObject({ ok: true, admitted: false, state: "pending-admission" });
    expect(early.ok && early.reason).toContain("human review");
    const incident = await api.request({ changeId: "c1", priority: "incident", by: agent });
    expect(incident).toMatchObject({ ok: false, error: { code: "forbidden" } });
    await env.ports.store.updateChange("c1", { status: "queued" });
    await env.admit(c1);
    expect(svc.loop.state.entries.c1?.priority).toBe("security"); // the option applied at admission
    const waiting = api.waitForMerge("c1", 50_000);
    await env.drive();
    const r = await waiting;
    expect(r.reason).toBe("merged");
    expect(r.status?.mergedSha).toBe(env.ports.git.head("app"));
  });

  it("a resolution with new lines invalidates a Lane 1 approval: back to review, a human approves, it lands", async () => {
    const s = await scenario({ name: "app", files: { "src/a.ts": "export const a = 1;\n" } });
    const env = attachAgentQueue(s, s.repo, {
      config: { maxBatchSize: 1 },
      resolver: () => ({ "src/a.ts": "export const a = 3; // both\n" }),
      scope: { novelLines: 1 },
    });
    const start = (title: string) =>
      s.coordinator.startChange(s.agent, {
        repoId: s.repo.id,
        planId: `plan-${s.repo.id}`,
        title,
        category: "fix",
      });
    const a = (await start("A")).change;
    const b = (await start("B")).change;
    const ha = push(s, a, { "src/a.ts": "export const a = 10;\n" });
    const hb = push(s, b, { "src/a.ts": "export const a = 2;\n" });
    for (const [c, h] of [
      [a, ha],
      [b, hb],
    ] as const)
      await s.coordinator.onPush({
        repoName: c.forkName,
        ref: "refs/heads/main",
        before: c.baseSha,
        after: h,
      });
    await s.settle();
    for (const c of [a, b])
      await s.coordinator.submitReview(s.reviewer, c.id, { decision: "approve" });
    for (let i = 0; i < 40 && (await reload(s, b.id)).status !== "awaiting-review"; i++) {
      await s.settle();
      s.ports.clock.advance(20_000);
      await env.queue().alarm();
    }
    const held = await reload(s, b.id);
    expect(held.status).toBe("awaiting-review"); // the earlier approval no longer covers what lands
    expect(held.laneReasons.map((r) => r.code)).toContain("merge-queue.resolution-novel-lines");
    expect(env.queue().loop.state.entries[b.id]?.hold).toBe("approval");
    expect(s.ports.notifier.kinds(b.id)).toContain("review-requested");
    // The reviewer re-toured the resolved head (its evidence carries the conflict resolution).
    const resolvedHead = env.queue().loop.state.entries[b.id]?.headSha;
    expect(s.ports.reviewer.tourCalls.at(-1)?.change.headSha).toBe(resolvedHead);
    expect(held.tourId).not.toBeNull();
    // The author can never approve; another human can.
    await expect(
      s.coordinator.submitReview(s.agent, b.id, { decision: "approve" }),
    ).rejects.toThrow();
    await s.coordinator.submitReview(s.reviewer, b.id, { decision: "approve" });
    await env.drive();
    await s.settle();
    expect(env.queue().loop.state.entries[b.id]?.state).toBe("merged");
    expect((await reload(s, b.id)).mergedSha).not.toBeNull();
    assertMainNeverRed(env);
  });
});
