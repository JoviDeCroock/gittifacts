/**
 * The shell loop on its own: one transaction per step (state + outbox + events), idempotent
 * command execution with retries, and the halt on `InvariantViolation` (nothing persisted).
 */
import { type Command, initialState, initialTrainState, queueConfig } from "@app/merge-queue";
import { describe, expect, it, vi } from "vitest";
import { type HaltInfo, QueueHaltedError, QueueLoop } from "../../src/queue/loop.js";
import { QueueStore } from "../../src/queue/store.js";
import { sqlite } from "./queue-harness.js";

const MAIN = "a".repeat(40);

function setup(core: (cmd: Command) => Promise<void> = async () => undefined) {
  const { sql, transact } = sqlite();
  const store = new QueueStore(sql, transact);
  let now = 1_000;
  const halts: HaltInfo[] = [];
  const handled: string[] = [];
  const loop = new QueueLoop(
    store,
    {
      core: async (cmd) => {
        handled.push(cmd.type);
        await core(cmd);
      },
      train: async () => undefined,
      giveUp: () => null,
      onEvents: () => undefined,
      onHalt: async (h) => void halts.push(h),
      onDropped: async () => undefined,
    },
    {
      now: () => now,
      initialState: () => initialState(MAIN, queueConfig(), 0),
      initialTrains: () => initialTrainState(),
      backoffMs: () => 10,
    },
  );
  const advance = (ms: number) => {
    now += ms;
  };
  return { store, loop, halts, handled, advance };
}

const enqueued = {
  type: "Enqueued",
  changeId: "c1",
  headSha: "b".repeat(40),
  authorId: "agent-1",
  enqueuedBy: { principalId: "agent-1", kind: "agent", sessionId: null },
  lane: 0,
} as const;

describe("QueueLoop", () => {
  it("persists the state, its commands and its §5 events in one step, then runs the commands", async () => {
    const t = setup();
    t.loop.dispatch(enqueued);
    // Reloaded from SQLite: the entry and the command that asks for its affected set.
    expect(t.store.loadState()?.entries.c1?.state).toBe("waiting");
    await t.loop.settle();
    expect(t.handled).toEqual(expect.arrayContaining(["ComputeAffectedSet", "Audit"]));
    expect(t.store.pendingCommands()).toBe(0);
  });

  it("retries a failing command with backoff and keeps it until it succeeds", async () => {
    let failures = 2;
    const t = setup(async (cmd) => {
      if (cmd.type === "ComputeAffectedSet" && failures-- > 0) throw new Error("sandbox down");
    });
    t.loop.dispatch(enqueued);
    await t.loop.settle();
    expect(t.store.pendingCommands()).toBe(1); // waiting for its backoff
    for (let i = 0; i < 3; i++) {
      t.advance(20);
      await t.loop.settle();
    }
    expect(t.store.pendingCommands()).toBe(0);
    expect(t.handled.filter((x) => x === "ComputeAffectedSet")).toHaveLength(3);
  });

  it("halts on InvariantViolation: nothing of the step is persisted, it alerts, and refuses work until resumed", async () => {
    const t = setup();
    // A CAS in flight for a batch that does not exist: the core refuses to apply its result.
    const broken = initialState(MAIN, queueConfig(), 0);
    broken.cas = {
      casId: "c1",
      batchId: "ghost",
      expectedOld: MAIN,
      newSha: "c".repeat(40),
      treeSha: "d".repeat(40),
      entries: [],
      issuedAt: 0,
    };
    t.store.commit({ state: broken, now: 0 });
    expect(() =>
      t.loop.dispatch({ type: "CasResult", casId: "c1", result: "ok", actualSha: "c".repeat(40) }),
    ).toThrow(/cas\.batch/);
    await vi.waitFor(() => expect(t.halts).toHaveLength(1));
    expect(t.halts[0]?.code).toBe("cas.batch");
    expect(t.store.loadState()?.cas?.casId).toBe("c1"); // untouched
    expect(t.store.loadState()?.main.sha).toBe(MAIN);
    expect(() => t.loop.dispatch({ type: "Tick" })).toThrow(QueueHaltedError);
    t.loop.resume();
    expect(t.loop.halted).toBeNull();
  });
});
