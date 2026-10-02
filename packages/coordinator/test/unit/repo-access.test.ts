/**
 * The `access` port (repo membership): every actor-driven facade call asks it, so a route that
 * forgets cannot let a non-member act. `hidden` answers like a missing repo/change; `denied` is
 * forbidden; the system principal is never asked.
 */
import type { Principal } from "@app/domain";
import { describe, expect, it } from "vitest";
import { CoordinatorError } from "../../src/api.js";
import { portsForRole, principal } from "../../src/fakes/index.js";
import { type RepoAccess, type RepoNeed, SYSTEM_PRINCIPAL_ID } from "../../src/ports.js";
import { createCoordinator } from "../../src/service.js";
import { type Scenario, scenario, startAndPush } from "./helpers.js";

type Verdict = "allowed" | "hidden" | "denied";

/** A table-driven access port that records what it was asked. */
function fakeAccess(rule: (actor: Principal, need: RepoNeed) => Verdict) {
  const asked: string[] = [];
  const access: RepoAccess = {
    async check(actor, repoId, need) {
      asked.push(`${actor.id}:${repoId}:${need}`);
      return rule(actor, need);
    },
  };
  return { access, asked };
}

function guarded(s: Scenario, access: RepoAccess) {
  return createCoordinator({ ...portsForRole(s.ports, "default"), access }, s.bindings);
}

async function code(p: Promise<unknown>): Promise<string> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(CoordinatorError);
  return (e as CoordinatorError).code;
}

describe("coordinator access port", () => {
  it("a non-member reviewer gets not-found, a member without the role forbidden; nothing is recorded", async () => {
    const s = await scenario();
    const { change } = await startAndPush(s);
    const stranger = principal({ kind: "human" });
    const { access, asked } = fakeAccess((actor) =>
      actor.id === stranger.id ? "hidden" : actor.id === s.reviewer.id ? "denied" : "allowed",
    );
    const c = guarded(s, access);
    expect(await code(c.submitReview(stranger, change.id, { decision: "approve" }))).toBe(
      "not-found",
    );
    expect(await code(c.submitReview(s.reviewer, change.id, { decision: "approve" }))).toBe(
      "forbidden",
    );
    expect(s.ports.store.reviews.size).toBe(0);
    expect(asked).toContain(`${s.reviewer.id}:${s.repo.id}:review`);
  });

  it("an allowed reviewer reviews as before", async () => {
    const s = await scenario();
    const { change } = await startAndPush(s);
    const c = guarded(s, fakeAccess(() => "allowed").access);
    await c.submitReview(s.reviewer, change.id, { decision: "approve" });
    expect([...s.ports.store.reviews.values()]).toEqual([
      expect.objectContaining({ reviewerId: s.reviewer.id, decision: "approve" }),
    ]);
  });

  it("start_change and push tokens need contribute; kill needs approve; Lane 0 needs admin", async () => {
    const s = await scenario();
    const { change } = await startAndPush(s);
    const { access, asked } = fakeAccess(() => "denied");
    const c = guarded(s, access);
    const start = c.startChange(s.agent, {
      repoId: s.repo.id,
      title: "more",
      category: "fix",
      planId: `plan-${s.repo.id}`,
    });
    expect(await code(start)).toBe("forbidden");
    expect(await code(c.refreshPushGrant(s.agent, change.id))).toBe("forbidden");
    expect(await code(c.kill(s.reviewer, change.id, "broken"))).toBe("forbidden");
    expect(await code(c.setLane0(s.owner, s.repo.id, false))).toBe("forbidden");
    expect(await code(c.abandon(s.agent, change.id))).toBe("forbidden");
    expect(asked.map((a) => a.split(":").pop())).toEqual([
      "contribute",
      "contribute",
      "approve",
      "admin",
      "contribute",
    ]);
  });

  it("waiting on or watching a hidden change is not-found; the system principal is never asked", async () => {
    const s = await scenario();
    const { change } = await startAndPush(s);
    const stranger = principal({ kind: "agent", ownerId: "hu_other" });
    const { access, asked } = fakeAccess(() => "hidden");
    const c = guarded(s, access);
    expect(await code(c.waitFor(stranger, change.id, "merged", 0))).toBe("not-found");
    expect(
      await code(c.watchChange(stranger, change.id, { since: null, timeoutMs: 0 })),
    ).toBe("not-found");
    const system = principal({ kind: "system", id: SYSTEM_PRINCIPAL_ID });
    await c.watchChange(system, change.id, { since: null, timeoutMs: 0 });
    expect(asked.every((a) => !a.startsWith(`${SYSTEM_PRINCIPAL_ID}:`))).toBe(true);
  });
});
