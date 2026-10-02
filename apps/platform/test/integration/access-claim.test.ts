/**
 * Unclaimed projects and membership, over the real coordinator facade with its access port (as in
 * production, src/coordinator.ts): no human can see, review or approve anything in an unclaimed
 * project; claiming makes the claimer its owner member; everyone else stays out.
 */
import { env } from "cloudflare:workers";
import { CoordinatorError, cloudflareBindings, createCoordinator } from "@app/coordinator";
import type { ProjectCreated } from "@app/mcp";
import { describe, expect, it } from "vitest";
import { repoAccessPort } from "../../src/access/port.js";
import { createApp } from "../../src/app.js";
import { TEST_DUMMY_TOKEN } from "../../src/claim/turnstile.js";
import { facadeOptions } from "../../src/coordinator.js";
import { buildPorts } from "../../src/runtime/ports.js";
import { ORIGIN, signUpHuman, type TestApp } from "../http.js";
import { integrationOverrides } from "./fakes.js";
import { createUnclaimed, request } from "./unclaimed-helpers.js";

function facade(e: Env) {
  return createCoordinator(
    buildPorts(e, "default", {
      overrides: { ...integrationOverrides("default", e), access: repoAccessPort(e) },
    }),
    cloudflareBindings(e),
    facadeOptions(ORIGIN),
  );
}

const guardedApp = (): TestApp => createApp({ coordinator: (e) => facade(e) });

const claimToken = (p: ProjectCreated) => (p.claimUrl as string).split("/claim/")[1] as string;

async function codeOf(p: Promise<unknown>): Promise<string> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(CoordinatorError);
  return (e as CoordinatorError).code;
}

describe("unclaimed projects and membership", () => {
  it("nobody reviews or approves before the claim; the claimer becomes owner; others stay out", async () => {
    const app = guardedApp();
    const p = await createUnclaimed(app);
    const token = p.token as string;
    const changeId = p.remote?.changeId as string;
    const drafted = await request(app, "POST", "/api/v1/plans", {
      token,
      body: {
        repoId: p.projectId,
        title: "First feature",
        intent: "Show the project works end to end.",
        acceptanceCriteria: ["GET / answers 200"],
      },
    });
    expect(drafted.status).toBe(201);
    const { plan } = (await drafted.json()) as { plan: { id: string } };

    const hal = await signUpHuman(app, "Hal");
    const ivy = await signUpHuman(app, "Ivy");
    for (const human of [hal, ivy]) {
      const auth = { cookie: human.cookie };
      for (const [method, path, body] of [
        ["GET", `/api/v1/repos/${p.projectId}`, undefined],
        ["GET", `/api/v1/changes/${changeId}`, undefined],
        ["POST", `/api/v1/plans/${plan.id}/approve`, {}],
        ["POST", `/api/v1/changes/${changeId}/review`, { decision: "approve" }],
      ] as const) {
        const res = await request(app, method, path, { ...auth, ...(body ? { body } : {}) });
        expect({ path, status: res.status }).toEqual({ path, status: 404 });
      }
      // The facade refuses too, even if a route forgot to ask.
      const c = facade(env);
      expect(await codeOf(c.submitReview(human.principal, changeId, { decision: "approve" }))).toBe(
        "not-found",
      );
      expect(
        await codeOf(c.watchChange(human.principal, changeId, { since: null, timeoutMs: 0 })),
      ).toBe("not-found");
    }

    const claimed = await request(app, "POST", `/api/v1/claims/${claimToken(p)}`, {
      cookie: hal.cookie,
      body: { turnstileToken: TEST_DUMMY_TOKEN },
    });
    expect(claimed.status).toBe(200);
    const members = (await (
      await request(app, "GET", `/api/v1/repos/${p.projectId}/members`, { cookie: hal.cookie })
    ).json()) as { members: { principalId: string; role: string }[] };
    expect(members.members.map((m) => [m.principalId, m.role])).toEqual([
      [hal.principal.id, "owner"],
    ]);
    // Hal owns the project and its agent now: he may approve the agent's plan (recorded).
    const approved = await request(app, "POST", `/api/v1/plans/${plan.id}/approve`, {
      cookie: hal.cookie,
      body: {},
    });
    expect(approved.status).toBe(200);
    // Reviewing reaches the coordinator (nothing to review yet: the change awaits a push).
    const review = await request(app, "POST", `/api/v1/changes/${changeId}/review`, {
      cookie: hal.cookie,
      body: { decision: "approve" },
    });
    expect(review.status).toBe(409);
    // The project's agent keeps working (now with Hal's owner role, still unable to approve).
    expect((await request(app, "GET", `/api/v1/changes/${changeId}`, { token })).status).toBe(200);
    // Ivy is still a stranger.
    const ivySees = await request(app, "GET", `/api/v1/repos/${p.projectId}`, {
      cookie: ivy.cookie,
    });
    expect(ivySees.status).toBe(404);
    expect(
      await codeOf(facade(env).submitReview(ivy.principal, changeId, { decision: "approve" })),
    ).toBe("not-found");
  });
});
