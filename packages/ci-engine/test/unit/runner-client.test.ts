import { describe, expect, it } from "vitest";
import {
  type DurableRunnerStub,
  RunnerJobLostError,
  runDurably,
  runOnRunner,
} from "../../src/runner/client.js";

const noSleep = { sleep: async () => {}, retryDelayMs: () => 0 };
const running = {
  state: "running",
  jobId: "main",
  startedAt: "2026-10-03T00:00:00Z",
  elapsedMs: 5,
};
const done = (outcome: unknown, launch = 1) => ({ state: "done", jobId: "main", launch, outcome });

function stub(
  start: unknown,
  polls: Array<unknown | Error>,
): DurableRunnerStub & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async start() {
      calls.push("start");
      return start;
    },
    async poll(_id, wait) {
      calls.push(`poll:${wait}`);
      const next = polls.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

describe("runDurably", () => {
  it("long-polls a running job until it is done", async () => {
    const s = stub(running, [running, done({ ok: true })]);
    const res = await runDurably(s, "main", {}, { ...noSleep, waitMs: 1234 });
    expect(res).toEqual({ outcome: { ok: true }, launch: 1, attached: false, polls: 2 });
    expect(s.calls).toEqual(["start", "poll:1234", "poll:1234"]);
  });

  it("returns a finished job from start without polling, and reports the re-attach", async () => {
    const s = stub({ ...done({ ok: true }, 3), attached: true }, []);
    expect(await runDurably(s, "main", {}, noSleep)).toMatchObject({
      launch: 3,
      attached: true,
      polls: 0,
    });
  });

  it("rides out dropped polls, and gives up after maxPollFailures in a row", async () => {
    const lost = new Error("Network connection lost.");
    const ok = stub(running, [lost, lost, running, lost, done({ ok: true })]);
    expect(await runDurably(ok, "main", {}, { ...noSleep, maxPollFailures: 3 })).toMatchObject({
      outcome: { ok: true },
    });
    const dead = stub(running, [lost, lost, lost]);
    await expect(runDurably(dead, "main", {}, { ...noSleep, maxPollFailures: 3 })).rejects.toThrow(
      "Network connection lost.",
    );
  });

  it("throws RunnerJobLostError for a lost or unknown job (the retry starts it again)", async () => {
    const lost = stub(running, [{ state: "lost", jobId: "main", reason: "restarted" }]);
    await expect(runDurably(lost, "main", {}, noSleep)).rejects.toBeInstanceOf(RunnerJobLostError);
    const unknown = stub({ state: "unknown", jobId: "main" }, []);
    await expect(runDurably(unknown, "main", {}, noSleep)).rejects.toThrow(/no record/);
  });

  it("rejects a malformed answer instead of retrying it", async () => {
    const s = stub(running, [{ state: "weird" }, done({ ok: true })]);
    await expect(runDurably(s, "main", {}, noSleep)).rejects.toThrow(/invalid poll result/);
  });
});

describe("runOnRunner", () => {
  it("falls back to the one-shot run() for stubs without start/poll", async () => {
    const calls: unknown[] = [];
    const legacy = { run: async (job: Record<string, unknown>) => (calls.push(job), { ok: true }) };
    expect(await runOnRunner(legacy, "main", { a: 1 })).toEqual({ ok: true });
    expect(calls).toEqual([{ a: 1 }]);
  });

  it("uses start/poll when the stub has them", async () => {
    const s = stub(running, [done({ ok: true, exitCode: 0 })]);
    const full = { run: async () => ({ ok: false }), start: s.start, poll: s.poll };
    expect(await runOnRunner(full, "main", {}, noSleep)).toEqual({ ok: true, exitCode: 0 });
  });
});
