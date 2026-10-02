import type { Repo } from "@app/domain";
import { describe, expect, it } from "vitest";
import { deployScriptName } from "../src/services/repos.js";
import { repoFixture, store } from "./fixtures.js";
import { call, createAgent, expectError, json, makeApp, signUpHuman } from "./http.js";

async function world(over: Partial<Repo> = {}) {
  const { app } = makeApp();
  const human = await signUpHuman(app);
  const agent = await createAgent(app, human.cookie);
  const s = store();
  const repo = repoFixture(over);
  await s.insertRepo(repo);
  return { app, human, agent, s, repo };
}

const path = (repoId: string) => `/api/v1/repos/${repoId}/deploy-target`;

describe("PATCH /api/v1/repos/{repoId}/deploy-target", () => {
  it("sets a namespaced Worker, audits it, and clears it with null", async () => {
    const { app, human, s, repo } = await world();
    const set = await json<{ repo: Repo; script: string }>(
      await call(app, "PATCH", path(repo.id), { cookie: human.cookie, body: { script: "api" } }),
    );
    const expected = deployScriptName(repo.id, "api");
    expect(expected.startsWith("gf-")).toBe(true);
    expect(set.script).toBe(expected);
    expect(set.repo.deployTarget).toBe(expected);
    expect((await s.getRepo(repo.id))?.deployTarget).toBe(expected);

    const audit = await json<{ events: Array<{ action: string; principalId: string }> }>(
      await call(app, "GET", `/api/v1/audit?subject=repo:${repo.id}`, { cookie: human.cookie }),
    );
    expect(audit.events.map((e) => e.action)).toContain("repo.deploy-target-set");
    expect(audit.events[0]?.principalId).toBe(human.principal.id);

    const cleared = await json<{ repo: Repo; script: null }>(
      await call(app, "PATCH", path(repo.id), { cookie: human.cookie, body: { script: null } }),
    );
    expect(cleared.repo.deployTarget).toBeNull();
  });

  it("never lets a project name the platform's Worker or another project's", () => {
    expect(deployScriptName("k3j9abcdefghij012345", "gittifacts")).toBe(
      "gf-k3j9abcdefghij012345-gittifacts",
    );
    expect(deployScriptName("repo_ABC", "api")).toBe("gf-repo-abc-api");
    expect(deployScriptName("r1", "api")).not.toBe(deployScriptName("r2", "api"));
  });

  it("refuses unclaimed projects with a fix", async () => {
    const { app, human, repo } = await world({
      claim: { status: "unclaimed", ownerId: null, expiresAt: "2099-01-01T00:00:00.000Z" },
    });
    const body = await expectError(
      await call(app, "PATCH", path(repo.id), { cookie: human.cookie, body: { script: "api" } }),
      403,
      "unclaimed-limit",
    );
    expect(body.error.message).toContain("deploy target");
  });

  it("is for humans only and validates the name", async () => {
    const { app, human, agent, repo } = await world();
    await expectError(
      await call(app, "PATCH", path(repo.id), { token: agent.token, body: { script: "api" } }),
      403,
      "forbidden",
    );
    for (const script of ["", "API", "-api", "api-", "a_b", "x".repeat(40), "gittifacts.dev"]) {
      await expectError(
        await call(app, "PATCH", path(repo.id), { cookie: human.cookie, body: { script } }),
        400,
        "invalid-request",
      );
    }
    await expectError(
      await call(app, "PATCH", path("missing"), { cookie: human.cookie, body: { script: "api" } }),
      404,
      "not-found",
    );
  });
});
