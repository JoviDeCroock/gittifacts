/**
 * The merge queue never stalls silently (journey 06, take 1: approved Changes sat in "Building
 * tree" for 16 min with an ETA showing and three "command dropped" audits without a reason):
 * every dropped command records its error class and redacted message, a given-up build is rebuilt
 * at once, the view shows the stall with what happens next and no ETA, and a stall past the build
 * timeout notifies a person.
 */
import { describe, expect, it } from "vitest";
import { describeFailure, redactSecrets } from "../../src/queue/failure.js";
import { recentProblems } from "../../src/queue/problems.js";
import { overviewView } from "../../src/queue/views.js";
import { type QueueEnv, queueEnv } from "./queue-harness.js";

describe("describeFailure / redactSecrets", () => {
  it("keeps the class and the message, without credentials", () => {
    const f = describeFailure(
      new TypeError(
        "fetch https://x-token:s3cr3tvalue@artifacts.example/repo.git failed; Authorization: Bearer abc.def.ghi12345 token=zzz123 gtf_abcdefgh123",
      ),
    );
    expect(f.errorClass).toBe("TypeError");
    expect(f.message).not.toMatch(/s3cr3tvalue|abc\.def|zzz123|gtf_abcdefgh123/);
    expect(f.message).toContain("fetch https://[redacted]@artifacts.example/repo.git failed");
  });
  it("leaves shas and ordinary words alone, and names non-Error throws", () => {
    const sha = "eb99ce836502a1b2c3d4e5f60718293a4b5c6d7e";
    expect(redactSecrets(`head ${sha} has no tree`)).toBe(`head ${sha} has no tree`);
    expect(describeFailure("boom")).toEqual({ errorClass: "string", message: "boom" });
    expect(describeFailure(new Error(""))).toEqual({
      errorClass: "Error",
      message: "(no message)",
    });
  });
});

/** A Change whose base is behind main: its batch tree needs a replay job (not the fast path). */
async function behindMain(env: QueueEnv) {
  const c1 = await env.change("c1", { "src/b.ts": "export const b = 1;\n" });
  env.ports.git.commit("app", "main", { "docs/x.md": "moved\n" }, "main moved");
  return c1;
}

describe("merge queue stalls", () => {
  it("a build that keeps failing: retrying with the reason and no ETA, then dropped with why, rebuilt at once, and lands", async () => {
    const env = await queueEnv();
    const c1 = await behindMain(env);
    const real = env.jobs.buildBatch.bind(env.jobs);
    let failures = 6;
    env.jobs.buildBatch = async (input) => {
      if (failures-- > 0)
        throw new TypeError(
          "queue build job failed (500): https://u:hunter2secret@scratch.example/x.git",
        );
      return real(input);
    };
    await env.admit(c1);
    const svc = env.queue();
    await svc.loop.settle();
    const view = overviewView({
      repoId: env.repo.id,
      state: svc.loop.state,
      trains: svc.loop.trains,
      halted: null,
      now: svc.ctx.now(),
      intentOf: () => null,
      stalls: svc.stalls(),
    });
    expect(view.stalls).toHaveLength(1);
    expect(view.stalls[0]).toMatchObject({
      state: "retrying",
      command: "BuildBatchTree",
      changeIds: ["c1"],
      attempts: 1,
      error: { errorClass: "TypeError" },
      next: { kind: "retry" },
    });
    expect(view.stalls[0]?.error?.message).not.toContain("hunter2secret");
    const entry = view.entries.find((e) => e.changeId === "c1");
    expect(entry?.stall).toBe("retrying");
    expect(entry?.etaSeconds).toBeNull();
    expect(entry?.reason).toMatch(/^retrying: building the batch tree failed 1 time: TypeError/);

    await env.drive();
    const { audit } = env.ports;
    const dropped = audit.events.findIndex((e) => e.action === "merge-queue.command-dropped");
    expect(dropped).toBeGreaterThanOrEqual(0);
    expect(audit.payloads[dropped]).toMatchObject({
      type: "BuildBatchTree",
      attempts: 6,
      errorClass: "TypeError",
      changeIds: ["c1"],
      next: expect.stringContaining("rebuilt at once"),
    });
    expect(JSON.stringify(audit.payloads[dropped])).not.toContain("hunter2secret");
    expect(audit.actions()).toContain("merge-queue.build-errored");
    expect((await env.ports.store.getChange("c1"))?.status).toBe("merged");
    expect(svc.stalls()).toEqual([]);
  });

  it("a build past the build timeout notifies a person and is rebuilt", async () => {
    const env = await queueEnv();
    const c1 = await behindMain(env);
    const real = env.jobs.buildBatch.bind(env.jobs);
    let hang = true;
    let timeOut: (e: Error) => void = () => undefined;
    env.jobs.buildBatch = (input) =>
      hang
        ? new Promise((_, reject) => {
            timeOut = reject;
          })
        : real(input);
    await env.admit(c1);
    const svc = env.queue();
    await svc.alarm();
    env.ports.clock.advance(16 * 60_000);
    hang = false;
    await svc.alarm();
    const stuck = env.ports.notifier.sent.find((n) => n.message.includes("merge queue was stuck"));
    expect(stuck).toMatchObject({ kind: "failing", changeId: "c1" });
    expect(stuck?.message).toContain("15 min");
    expect(env.ports.audit.actions()).toContain("merge-queue.batch-timed-out");
    timeOut(new Error("queue build job timed out")); // the hung job ends at its own limit
    await env.drive();
    expect((await env.ports.store.getChange("c1"))?.status).toBe("merged");
  });
});

/**
 * A batch run whose BatchRunWorkflow ends without reporting (live 2026-10-11: the engine refused
 * four landing revalidations, the instances errored, and the landings sat "running" for 25+ min
 * with no stall shown). The alarm's run watch counts such a run as errored within a minute, the
 * batch is retried, and a run hanging past the build timeout shows as a stall meanwhile.
 */
describe("batch runs that never report", () => {
  it("a run whose Workflow errored without a result is retried by the run watch and lands", async () => {
    const env = await queueEnv();
    const c1 = await env.change("c1", { "src/b.ts": "export const b = 1;\n" });
    const runner = env.bindings.batchRuns.runner!;
    let lose = 1;
    env.bindings.batchRuns.runner = async (params, step, id) => {
      if (lose-- > 0)
        throw new Error("InvalidRunRequestError: testTargets: Too small: expected >=1 items");
      return runner(params, step, id);
    };
    const start = env.ports.clock.now().getTime();
    await env.admit(c1);
    const svc = env.queue();
    await svc.loop.settle();
    await env.bindings.batchRuns.settle();
    expect(Object.values(svc.loop.state.batches).map((b) => b.state)).toContain("running");
    env.ports.clock.advance(61_000);
    await svc.alarm();
    expect(env.ports.audit.actions()).toContain("merge-queue.run-lost");
    const lost = recentProblems(svc.store).find((p) => p.kind === "run-lost");
    expect(lost).toMatchObject({ command: "StartBatchRun", changeIds: ["c1"] });
    expect(lost?.message).toContain("InvalidRunRequestError");
    await env.drive(20);
    expect((await env.ports.store.getChange("c1"))?.status).toBe("merged");
    // Minutes, not the 90-minute run timeout.
    expect(env.ports.clock.now().getTime() - start).toBeLessThan(10 * 60_000);
    expect(svc.stalls()).toEqual([]);
  });

  it("a landing revalidation hanging past the build timeout shows as a stall, then is retried and lands", async () => {
    const env = await queueEnv();
    const c1 = await env.change("c1", { "src/b.ts": "export const b = 1;\n" });
    const c2 = await env.change("c2", { "src/c.ts": "export const c = 1;\n" });
    const runner = env.bindings.batchRuns.runner!;
    let hangs = 1;
    let fail: (e: Error) => void = () => undefined;
    env.bindings.batchRuns.runner = (params, step, id) => {
      const cmd = params.command;
      if (cmd.type === "StartBatchRun" && cmd.kind === "landing" && hangs-- > 0)
        return new Promise((_, reject) => {
          fail = reject;
        });
      return runner(params, step, id);
    };
    await env.admit(c1);
    await env.admit(c2);
    const svc = env.queue();
    const landing = () =>
      Object.values(svc.loop.state.batches).find(
        (b) => b.kind === "landing" && b.state === "running",
      );
    for (let i = 0; i < 30 && landing() === undefined; i++) {
      await env.settle();
      env.ports.clock.advance(5_000);
      await svc.alarm();
    }
    const l = landing();
    expect(l, "no landing revalidation ran").toBeDefined();
    env.ports.clock.advance(16 * 60_000);
    await svc.alarm(); // the run watch leaves a live instance alone
    expect(svc.stalls()).toContainEqual(
      expect.objectContaining({
        state: "stalled",
        what: "Revalidating the landing batch on main",
        command: "StartBatchRun",
        batchId: l?.id,
        next: { kind: "retry", at: (l?.startedAt ?? 0) + svc.loop.state.config.runTimeoutMs },
      }),
    );
    fail(new Error("the CI engine is unreachable")); // the instance errors, never reporting
    await env.drive(20);
    expect((await env.ports.store.getChange("c2"))?.status).toBe("merged");
    expect(env.ports.audit.actions()).toContain("merge-queue.run-lost");
    expect(svc.stalls()).toEqual([]);
  });
});
