/**
 * The merge queue never stalls silently (journey 06, take 1: approved Changes sat in "Building
 * tree" for 16 min with an ETA showing and three "command dropped" audits without a reason):
 * every dropped command records its error class and redacted message, a given-up build is rebuilt
 * at once, the view shows the stall with what happens next and no ETA, and a stall past the build
 * timeout notifies a person.
 */
import { describe, expect, it } from "vitest";
import { describeFailure, redactSecrets } from "../../src/queue/failure.js";
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
