/**
 * rerun_ci and close_change (journey 10/M5 friction: no way to re-run a flaky CI without a
 * re-dated push, and no way to close a Change that will never merge).
 */
import { describe, expect, it } from "vitest";
import { CoordinatorError } from "../../src/api.js";
import { principal } from "../../src/fakes/index.js";
import { changeWorkflowId } from "../../src/ids.js";
import { reload, scenario, startAndPush } from "./helpers.js";

async function code(p: Promise<unknown>): Promise<string | null> {
  return p.then(
    () => null,
    (e: unknown) => {
      expect(e).toBeInstanceOf(CoordinatorError);
      expect((e as CoordinatorError).fix.explanation.length).toBeGreaterThan(0);
      return (e as CoordinatorError).code;
    },
  );
}

describe("rerun", () => {
  it("runs a fresh workflow instance and CI run on the same head, audited as the caller", async () => {
    const s = await scenario();
    let runs = 0;
    const green = s.ports.ci.outcome;
    s.ports.ci.outcome = (req) => {
      runs += 1;
      return { ...green(req), status: runs === 1 ? "failed" : "passed" };
    };
    const { change, headSha, instanceId } = await startAndPush(s);
    expect(change.status).toBe("failing");

    const out = await s.coordinator.rerun(s.agent, change.id, "flaky property test");
    expect(out.headSha).toBe(headSha);
    expect(out.instanceId).toBe(`${changeWorkflowId(change.id, headSha)}-r1`);
    expect(out.superseded).toBe(instanceId);
    expect(out.change.status).toBe("running");
    await s.settle();
    const after = await reload(s, change.id);
    expect(after.headSha).toBe(headSha);
    expect(after.status).not.toBe("failing");
    expect(s.ports.ci.runs.has(`run-${out.instanceId}`)).toBe(true);
    expect(s.ports.audit.payloadOf("change.rerun-requested")).toMatchObject({
      headSha,
      previousStatus: "failing",
      reason: "flaky property test",
    });
    const event = s.ports.audit.events.find((e) => e.action === "change.rerun-requested");
    expect(event?.principalId).toBe(s.agent.id);

    // A second re-run gets the next instance.
    await s.coordinator.rerun(s.owner, change.id);
    expect(
      s.bindings.changeWorkflow.instances.has(`${changeWorkflowId(change.id, headSha)}-r2`),
    ).toBe(true);
  });

  it("only the author, its owner or a human maintainer; never before a push or after approval", async () => {
    const s = await scenario();
    const { change } = await startAndPush(s);
    expect(await code(s.coordinator.rerun(principal({ kind: "agent" }), change.id))).toBe(
      "forbidden",
    );
    // A human reviewer with change:review stands in for a maintainer here (no access port).
    expect(await code(s.coordinator.rerun(s.reviewer, change.id))).toBeNull();

    const { change: fresh } = await s.coordinator.startChange(s.agent, {
      repoId: s.repo.id,
      title: "nothing pushed",
      category: "fix",
    });
    expect(await code(s.coordinator.rerun(s.agent, fresh.id))).toBe("invalid-state");

    await s.settle();
    await s.ports.store.updateChange(change.id, { status: "approved" });
    expect(await code(s.coordinator.rerun(s.agent, change.id))).toBe("invalid-state");
  });
});

describe("close (abandon) with a reason", () => {
  it("records the reason; a stranger agent is refused; closing twice is a no-op", async () => {
    const s = await scenario();
    const { change } = await startAndPush(s);
    expect(await code(s.coordinator.abandon(principal({ kind: "agent" }), change.id, "x"))).toBe(
      "forbidden",
    );
    const closed = await s.coordinator.abandon(
      s.agent,
      change.id,
      "  superseded by another change ",
    );
    expect(closed.status).toBe("abandoned");
    expect(s.ports.audit.payloadOf("change.abandoned")).toMatchObject({
      reason: "superseded by another change",
    });
    expect((await s.coordinator.abandon(s.agent, change.id)).status).toBe("abandoned");
    expect(s.ports.audit.actions().filter((a) => a === "change.abandoned")).toHaveLength(1);
  });
});

describe("wait_for_change across a deploy", () => {
  it("a DO that never answers: the service answers at timeout + grace with retryAfterSec", async () => {
    const s = await scenario();
    s.ports.ci.autoFinish = false;
    const { change } = await startAndPush(s);
    const core = s.bindings.changeCoordinator(change.id);
    core.waitFor = () => new Promise(() => {}); // reset by a deploy: never answers
    const started = Date.now();
    const r = await s.coordinator.waitFor(s.agent, change.id, "evidence_ready", 50);
    expect(Date.now() - started).toBeLessThan(5_000 + 2_000);
    expect(r).toMatchObject({ reached: false, reason: "timeout", retryAfterSec: 2 });
    expect(r.change.id).toBe(change.id);
  }, 15_000);

  it("a DO whose RPC fails answers from the store at once, reached when it already is", async () => {
    const s = await scenario();
    s.ports.ci.autoFinish = false;
    const { change } = await startAndPush(s);
    const core = s.bindings.changeCoordinator(change.id);
    core.waitFor = () =>
      Promise.reject(new Error("Durable Object reset because its code was updated."));
    const pending = await s.coordinator.waitFor(s.agent, change.id, "evidence_ready", 60_000);
    expect(pending).toMatchObject({ reached: false, reason: "timeout", retryAfterSec: 2 });
    await s.ports.store.updateChange(change.id, { evidenceId: "ev_1" });
    const reached = await s.coordinator.waitFor(s.agent, change.id, "evidence_ready", 60_000);
    expect(reached).toMatchObject({ reached: true, reason: "reached" });
    expect(reached.retryAfterSec).toBeUndefined();
  });
});
